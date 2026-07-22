#!/usr/bin/env python3
"""Summarize coverage JSON into a stable, human-readable report.

Heron has two coverage stacks, each emitting a *different* JSON shape:

  Rust  — `cargo-llvm-cov` (`cargo llvm-cov report --json --summary-only`,
           flat `{files, totals}`) and the underlying raw `llvm-cov export
           -summary-only` (`{data:[{files, summary}]}`).
  TS    — `bun test --coverage --coverage-reporter=json`
           (`{coverage:{files:[…], summary:{…}}}`), whose field names drift
           across Bun versions (`percent` | `coveredPercent` | `pct`,
           `coveredLines` | `covered`, `totalLines` | `count` | `lineCount`).

This parser is tolerant of all of the above. It deliberately **recomputes
percentages from raw line counts** rather than trusting an aggregate
`percent`/`totals` field, because those can fold in excluded files (Bun's
totals include test files the gate must not count) or be rounded.

For the TS stack the parser also **enforces the denominator itself**: it walks
`console/src/**/*.{ts,tsx}` excluding `.test.`/`.spec.` files, `__fixtures__`/
`fixtures`/`__mocks__` dirs, and `.d.ts` ambient files, and only counts files
that appear in Bun's coverage report. A source file Bun never instrumented
(think a leaf module with no tests touching it) contributes its *full* line
count to the denominator with zero covered — the honest gap.

Usage
-----
    summarize_coverage.py --kind rs|ts --json-file PATH [--text-log PATH]
                          [--top N] [--min PCT] [--gap-list]

Exit codes: 0 success · 1 coverage below --min (gate mode) · 2 bad invocation.

The JSON shapes are referenced from the project memory note on Heron coverage
tooling. Run the companion self-tests:
    python3 scripts/coverage/lib/test_summarize_coverage.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Iterable

# ──────────────────────────────────────────────────────────────────────────
# JSON shape tolerance
# ──────────────────────────────────────────────────────────────────────────

# Exclude patterns for the TS denominator. Mirrors the rule in the project
# memory: src/**/*.{ts,tsx} minus .test./.spec./__fixtures__//fixtures//__mocks__/.d.ts
_TS_EXCLUDE_RE = re.compile(
    r"(?:^|/)"            # dir boundary or start
    r"(?:__fixtures__|fixtures|__mocks__|mocks)"  # fixture/mock dirs
    r"(?:/|$)"
)
# A test/spec file, or a Bun-generated- ambient `.d.ts`. `.test.`/`.spec.`
# anywhere in the basename counts (covers `foo.test.ts`, `foo.test.tsx`).
_TS_TESTFILE_RE = re.compile(r"\.(?:test|spec)\.(?:ts|tsx)$")
_TS_AMBIENT_RE = re.compile(r"\.d\.ts$")


def _count_covered(node: Any) -> tuple[int | None, int | None]:
    """Extract (total_lines, covered_lines) from one coverage node.

    A node is either a per-file record or an aggregate (totals/summary).
    Field families handled:

      llvm-cov :  {lines: {count, covered, percent}}            (flat cargo)
                  {summary: {lines: {count, covered}}}          (raw llvm)
      bun      :  {lineCount, coveredLines, percent|pct|coveredPercent}
                  {totalLines, coveredLines, …}
                  {count, covered, …}                            (legacy)

    `or` short-circuits on the first truthy hit; `0` lines is a real value so
    None-guards (explicit `is not None`) are used where it matters — but here
    a 0-count file contributes nothing to either side, so the truthy fallthrough
    is fine and simpler.
    """
    if not isinstance(node, dict):
        return None, None

    # llvm-cov flat: {lines: {count, covered}}
    lines = node.get("lines")
    if isinstance(lines, dict):
        return lines.get("count"), lines.get("covered")
    # raw llvm-cov per-file: {summary: {lines: {count, covered}}}
    summ = node.get("summary")
    if isinstance(summ, dict) and isinstance(summ.get("lines"), dict):
        return summ["lines"].get("count"), summ["lines"].get("covered")

    # Bun family — try the explicit total-fields first so a 0-covered source
    # file (all-missing) still reports its real total.
    total = node.get("lineCount")
    if total is None:
        total = node.get("totalLines")
    if total is None:
        total = node.get("count")
    cov = node.get("coveredLines")
    if cov is None:
        cov = node.get("covered")
    if total is not None and cov is not None:
        return total, cov
    return None, None


def _strip_noise(text: str) -> str:
    """Slice the first {...} JSON object out of text, trimming leading and
    trailing non-JSON noise (cargo banners, compiler warnings, blank lines).

    `cargo llvm-cov` may print banners like
        `     Finished test [unoptimized + debuginfo] target(s) in 0.12s`
    before the JSON blob, and `llvm-cov export` occasionally emits a stray
    blank line. `json.loads` chokes on any of it, so we find the first `{` and
    match braces to recover the object. We do *not* use regex across the whole
    string — JSON can contain `}` inside strings, which a naive regex miscounts.
    """
    s = text.strip()
    start = s.find("{")
    if start < 0:
        raise ValueError("no JSON object found in coverage output")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    # Unbalanced — fall back to raw, let json.loads raise a clear error.
    return s[start:]


def _load_json(path: str) -> Any:
    """Read a coverage JSON file, tolerant of leading/trailing non-JSON noise."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return json.loads(_strip_noise(raw))


def _find_files_and_totals(doc: Any) -> tuple[list[dict], dict]:
    """Locate the per-file list and the aggregate totals across shapes.

      cargo-llvm-cov flat  : {files:[…], totals:{…}}
      raw llvm-cov         : {data:[{files:[…], summary:{…}}], type, version}
      bun                  : {coverage:{files:[…], summary:{…}}}
    """
    if isinstance(doc, dict):
        data = doc.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict):
            rec = data[0]
            return list(rec.get("files", [])), (rec.get("summary") or rec.get("totals") or {})
        cov = doc.get("coverage")
        if isinstance(cov, dict):
            return list(cov.get("files", [])), (cov.get("summary") or {})
        if "files" in doc or "totals" in doc or "summary" in doc:
            return list(doc.get("files", [])), (doc.get("totals") or doc.get("summary") or {})
    if isinstance(doc, list) and doc and isinstance(doc[0], dict):
        # Some tooling wraps the report in a bare list.
        rec = doc[0]
        return list(rec.get("files", [])), (rec.get("summary") or rec.get("totals") or {})
    return [], {}


# ──────────────────────────────────────────────────────────────────────────
# Per-file normalization
# ──────────────────────────────────────────────────────────────────────────


def _file_path(rec: dict) -> str | None:
    """The file's source path. llvm-cov uses `filename`, Bun uses `path`."""
    return rec.get("filename") or rec.get("path") or rec.get("url")


def _pct(total: int | None, covered: int | None) -> float:
    """Recompute a percentage from counts (never trust a stored `percent`)."""
    if not total:
        return 0.0
    if covered is None:
        covered = 0
    return (covered / total) * 100.0 if total else 0.0


def _bucket_rust(path: str, server_root: str) -> str:
    """Group a Rust source path under its crate name.

    cargo-llvm-cov reports paths relative to the workspace, e.g.
    `h-storage-duckdb/src/exchanges.rs`. The crate is the first path segment.
    Files outside any `h-*`/`app/*` crate (generated, build scripts) bucket as
    `<other>`.
    """
    p = path.replace("\\", "/")
    # Strip a leading absolute or `server/` prefix so the first segment is the crate.
    if p.startswith(server_root):
        p = p[len(server_root):].lstrip("/")
    parts = p.split("/")
    if parts and (parts[0].startswith("h-") or parts[0] in ("app",)):
        return parts[0]
    if len(parts) >= 2 and parts[1].startswith("h-"):
        return parts[1]
    return "<other>"


def _ts_denominator_entries(src_root: str) -> list[str]:
    """Walk console/src/**/*.{ts,tsx} and return the files that belong in the
    TS denominator — i.e. excluding tests, fixtures/mocks, and ambient `.d.ts`.

    Returns repo-root-relative POSIX paths (`src/lib/foo.ts`). This is the
    SSOT list the gate trusts; Bun's own aggregate totals are *not* used as
    the denominator (they include the very test files we exclude here).
    """
    entries: list[str] = []
    if not os.path.isdir(src_root):
        return entries
    for dirpath, dirnames, filenames in os.walk(src_root):
        # Prune fixture/mock dirs in-place so os.walk doesn't descend.
        dirnames[:] = [d for d in dirnames if d not in ("__fixtures__", "fixtures", "__mocks__", "mocks")]
        for fn in filenames:
            if not (fn.endswith(".ts") or fn.endswith(".tsx")):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), src_root)
            posix = rel.replace("\\", "/")
            full = os.path.join(dirpath, fn)
            if _TS_TESTFILE_RE.search(posix):
                continue
            if _TS_AMBIENT_RE.search(posix):
                continue
            if _TS_EXCLUDE_RE.search(posix):
                continue
            entries.append(full)
    return entries


def _ts_line_count(path: str) -> int:
    """A cheap source-only line count for a TS file Bun never instrumented.

    We only ever call this for files *missing* from Bun's report (the gap), so
    it runs rarely. Counts non-blank lines; an exact count isn't critical —
    these files contribute to the denominator as "0 covered" regardless, and we
    only need a defensible total so the percentage is honest.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return sum(1 for ln in fh if ln.strip())
    except OSError:
        return 0


# ──────────────────────────────────────────────────────────────────────────
# Report assembly
# ──────────────────────────────────────────────────────────────────────────


class CoverageReport:
    """Aggregate of per-file (total, covered) tuples grouped by bucket."""

    def __init__(self) -> None:
        self.buckets: dict[str, list[tuple[str, int, int]]] = {}

    def add(self, bucket: str, path: str, total: int, covered: int) -> None:
        self.buckets.setdefault(bucket, []).append((path, total, covered))

    @property
    def total_lines(self) -> int:
        return sum(t for rows in self.buckets.values() for _, t, _ in rows)

    @property
    def covered_lines(self) -> int:
        return sum(c for rows in self.buckets.values() for _, _, c in rows)

    @property
    def pct(self) -> float:
        return _pct(self.total_lines, self.covered_lines)

    def bucket_summary(self) -> list[tuple[str, int, int, float]]:
        rows = []
        for bucket, items in self.buckets.items():
            t = sum(x for _, x, _ in items)
            c = sum(x for _, _, x in items)
            rows.append((bucket, t, c, _pct(t, c)))
        rows.sort(key=lambda r: (-r[1], r[0]))  # most lines first
        return rows

    def worst_uncovered(self, n: int) -> list[tuple[str, int, int, float]]:
        """The N files with the largest *uncovered* line count (gap), breaking
        ties by lowest percentage then by path. These are the gap list."""
        flat = [(p, t, c) for items in self.buckets.values() for p, t, c in items]
        flat.sort(key=lambda r: (-(r[1] - r[2]), r[3] if False else -_pct(r[1], r[2]), r[0]))
        return [(p, t, c, _pct(t, c)) for p, t, c in flat[:n]]


def build_rs_report(doc: Any, server_root: str) -> CoverageReport:
    files, _totals = _find_files_and_totals(doc)
    rep = CoverageReport()
    for rec in files:
        path = _file_path(rec)
        if path is None:
            continue
        total, covered = _count_covered(rec)
        if total is None:
            continue
        rep.add(_bucket_rust(path, server_root), path, total or 0, covered or 0)
    return rep


def build_ts_report(doc: Any, console_src: str, console_root: str) -> CoverageReport:
    files, _totals = _find_files_and_totals(doc)
    # Index Bun's per-file records by basename+relative path so we can match
    # against the denominator walk. Bun paths are console-relative (`src/…`),
    # but also tolerate bare basenames or absolute paths.
    by_key: dict[str, dict] = {}
    for rec in files:
        p = _file_path(rec)
        if p is None:
            continue
        key = p.replace("\\", "/")
        # Normalize: strip any leading console/ or absolute prefix down to src/….
        idx = key.find("src/")
        if idx >= 0:
            key = key[idx:]
        by_key[key] = rec
        by_key[os.path.basename(p)] = rec  # basename fallback

    rep = CoverageReport()
    # First, every file Bun *did* report (and that passes the denominator filter).
    used = set()
    for rec in files:
        p = _file_path(rec)
        if p is None:
            continue
        norm = p.replace("\\", "/")
        idx = norm.find("src/")
        rel = norm[idx:] if idx >= 0 else norm
        posix = rel
        if _TS_TESTFILE_RE.search(posix) or _TS_AMBIENT_RE.search(posix) or _TS_EXCLUDE_RE.search(posix):
            continue  # excluded from denominator — don't count coverage either
        total, covered = _count_covered(rec)
        if total is None:
            continue
        bucket = posix.split("/")[1] if posix.startswith("src/") and "/" in posix[4:] else posix.split("/")[0]
        rep.add(bucket, posix, total or 0, covered or 0)
        used.add(posix)
    # Then, denominator files Bun never reported → all-uncovered (the honest gap).
    for full in _ts_denominator_entries(console_src):
        rel = os.path.relpath(full, console_root).replace("\\", "/")
        posix = rel
        if posix in used:
            continue
        total = _ts_line_count(full)
        if total == 0:
            continue
        bucket = posix.split("/")[1] if posix.startswith("src/") and "/" in posix[4:] else posix.split("/")[0]
        rep.add(bucket, posix, total, 0)
    return rep


# ──────────────────────────────────────────────────────────────────────────
# Rendering
# ──────────────────────────────────────────────────────────────────────────

BLUE = "\033[0;34m"
GREEN = "\033[0;32m"
YELLOW = "\033[0;33m"
RED = "\033[0;31m"
DIM = "\033[2m"
BOLD = "\033[1m"
NC = "\033[0m"


def _color_for(pct: float, min_pct: float) -> str:
    if pct >= min_pct:
        return GREEN
    if pct >= min_pct - 10:
        return YELLOW
    return RED


def _fmt_pct(pct: float) -> str:
    return f"{pct:5.1f}%"


def render(
    rep: CoverageReport,
    *,
    kind: str,
    top: int,
    min_pct: float,
    gap_list: bool,
    text_log: str | None,
) -> str:
    out: list[str] = []
    overall = rep.pct
    color = _color_for(overall, min_pct)
    out.append("")
    out.append(f"{BOLD}{BLUE}📊 Coverage — {kind.upper()}{NC}")
    out.append("━" * 52)
    out.append(
        f"  Overall line coverage: {color}{BOLD}{_fmt_pct(overall)}{NC}"
        f"  {DIM}({rep.covered_lines}/{rep.total_lines} lines){NC}"
        f"  {DIM}gate: {min_pct:.0f}%{NC}"
    )
    out.append("")

    # Per-bucket summary.
    out.append(f"{BOLD}  Per-{'crate' if kind == 'rs' else 'dir'} summary{NC}")
    out.append(f"  {'bucket':<28} {'lines':>8} {'covered':>9} {'pct':>7}")
    out.append(f"  {'-' * 28} {'-' * 8} {'-' * 9} {'-' * 7}")
    for bucket, t, c, p in rep.bucket_summary():
        bc = _color_for(p, min_pct)
        out.append(f"  {bucket:<28} {t:>8} {c:>9} {bc}{_fmt_pct(p)}{NC}")
    out.append("")

    # Worst uncovered files (the gap list).
    if gap_list or top > 0:
        n = top if top > 0 else 10
        worst = rep.worst_uncovered(n)
        out.append(f"{BOLD}  Worst uncovered files{NC} {DIM}(top {n} by gap){NC}")
        out.append(f"  {'file':<54} {'gap':>5} {'pct':>7}")
        out.append(f"  {'-' * 54} {'-' * 5} {'-' * 7}")
        for path, t, c, p in worst:
            gap = t - c
            disp = path if len(path) <= 54 else "…" + path[-(53):]
            pc = _color_for(p, min_pct)
            out.append(f"  {disp:<54} {gap:>5} {pc}{_fmt_pct(p)}{NC}")
        if not worst:
            out.append(f"  {DIM}(no uncovered lines){NC}")
        out.append("")

    text = "\n".join(out) + "\n"
    # Persist the text log (without ANSI colors) for CI artifacts.
    if text_log:
        plain = _strip_ansi(text)
        try:
            os.makedirs(os.path.dirname(text_log), exist_ok=True)
        except OSError:
            pass
        with open(text_log, "w", encoding="utf-8") as fh:
            fh.write(plain)
    return text


_ANSI_RE = re.compile("\033\\[[0-9;]*m")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


# ──────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Summarize Heron coverage JSON.")
    p.add_argument("--kind", required=True, choices=["rs", "ts"], help="coverage stack")
    p.add_argument("--json-file", required=True, help="coverage JSON report to parse")
    p.add_argument("--text-log", help="also write a plain-text summary here (no ANSI)")
    p.add_argument("--top", type=int, default=15, help="worst-uncovered files to list (0 to hide)")
    p.add_argument("--min", type=float, default=90.0, help="gate threshold pct (default 90)")
    p.add_argument("--gate", action="store_true", help="exit 1 when overall pct < --min")
    p.add_argument(
        "--gap-list", action="store_true", default=True,
        help="print the worst-uncovered gap list (default on)",
    )
    p.add_argument("--no-gap-list", dest="gap_list", action="store_false")
    p.add_argument("--server-root", default="server", help="Rust workspace dir (for --kind rs)")
    p.add_argument("--console-root", default="console", help="console dir (for --kind ts)")
    args = p.parse_args(argv)

    doc = _load_json(args.json_file)

    if args.kind == "rs":
        rep = build_rs_report(doc, args.server_root)
    else:
        console_src = os.path.join(args.console_root, "src")
        rep = build_ts_report(doc, console_src, args.console_root)

    text = render(
        rep,
        kind=args.kind,
        top=args.top,
        min_pct=args.min,
        gap_list=args.gap_list,
        text_log=args.text_log,
    )
    sys.stdout.write(text)

    if args.gate:
        if rep.pct < args.min:
            print(f"{RED}✗ coverage {rep.pct:.1f}% < gate {args.min:.0f}%{NC}", file=sys.stderr)
            return 1
        print(f"{GREEN}✓ coverage {rep.pct:.1f}% ≥ gate {args.min:.0f}%{NC}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

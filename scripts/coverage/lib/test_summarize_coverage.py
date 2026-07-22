#!/usr/bin/env python3
"""Self-tests for scripts/coverage/lib/summarize_coverage.py.

Run:  python3 scripts/coverage/lib/test_summarize_coverage.py

No third-party deps — plain `unittest` against the module under test. The
env worktree has no cargo/bun, so the *coverage runs themselves* can't be
exercised here; these tests lock down the parser's tolerance of the three
JSON shapes (cargo-llvm-cov flat, raw llvm-cov, bun) plus the TS-denominator
enforcement and report ordering, which is where regressions would hide.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import summarize_coverage as sc  # noqa: E402


# ──────────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────────

CARGO_FLAT = {
    "files": [
        {"filename": "h-common/src/lib.rs", "summary": {"lines": {"count": 100, "covered": 90, "percent": 0.9}}},
        {"filename": "h-llm/src/x.rs", "summary": {"lines": {"count": 50, "covered": 20, "percent": 0.4}}},
        {"filename": "h-storage-duckdb/src/concurrent_tests.rs",
         "summary": {"lines": {"count": 60, "covered": 60, "percent": 1.0}}},
    ],
    "totals": {"lines": {"count": 210, "covered": 170, "percent": 0.8095}},
}

RAW_LLVM = {
    "data": [{
        "files": [
            {"filename": "h-api/src/main.rs", "summary": {"lines": {"count": 30, "covered": 15}}},
            {"filename": "app/heron/src/main.rs", "summary": {"lines": {"count": 12, "covered": 12}}},
        ],
        "summary": {"lines": {"count": 42, "covered": 27}},
    }],
    "type": "coverage.report.summary",
    "version": "0.1.0",
}

# Bun variants across versions: percent|pct|coveredPercent, coveredLines|covered, lineCount|totalLines
BUN_REPORT = {
    "coverage": {
        "files": [
            {"path": "src/lib/foo.ts", "lineCount": 40, "coveredLines": 30, "percent": 0.75},
            {"path": "src/lib/bar.test.ts", "lineCount": 20, "coveredLines": 20, "pct": 1.0},
            {"path": "src/lib/baz.tsx", "lineCount": 10, "covered": 9, "totalLines": 10, "coveredPercent": 0.9},
        ],
        "summary": {"percent": 0.9, "coveredLines": 59, "totalLines": 70},
    }
}

CARGO_NOISE = """     Finished test [unoptimized + debuginfo] target(s) in 0.12s
   Compiling foo
{"files":[{"filename":"h-common/src/lib.rs","summary":{"lines":{"count":10,"covered":8}}}],"totals":{"lines":{"count":10,"covered":8}}}
"""


# ──────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────


class TestShapeTolerance(unittest.TestCase):
    def test_cargo_flat_extracts_per_file(self):
        t, c = sc._count_covered(CARGO_FLAT["files"][0])
        self.assertEqual((t, c), (100, 90))

    def test_raw_llvm_per_file_nests_under_summary(self):
        t, c = sc._count_covered(RAW_LLVM["data"][0]["files"][0])
        self.assertEqual((t, c), (30, 15))

    def test_bun_lineCount_coveredLines_variant(self):
        t, c = sc._count_covered(BUN_REPORT["coverage"]["files"][0])
        self.assertEqual((t, c), (40, 30))

    def test_bun_covered_totalLines_variant(self):
        t, c = sc._count_covered(BUN_REPORT["coverage"]["files"][2])
        self.assertEqual((t, c), (10, 9))

    def test_find_files_cargo_flat(self):
        files, totals = sc._find_files_and_totals(CARGO_FLAT)
        self.assertEqual(len(files), 3)
        self.assertEqual(totals["lines"]["count"], 210)

    def test_find_files_raw_llvm_unwraps_data(self):
        files, totals = sc._find_files_and_totals(RAW_LLVM)
        self.assertEqual(len(files), 2)
        self.assertEqual(totals["lines"]["covered"], 27)

    def test_find_files_bun_unwraps_coverage(self):
        files, totals = sc._find_files_and_totals(BUN_REPORT)
        self.assertEqual(len(files), 3)
        self.assertEqual(totals["coveredLines"], 59)

    def test_strip_noise_slices_leading_banner(self):
        obj = json.loads(sc._strip_noise(CARGO_NOISE))
        self.assertEqual(obj["files"][0]["filename"], "h-common/src/lib.rs")

    def test_strip_noise_handles_strings_with_braces(self):
        raw = 'noise {"a":"} tricky","b":{"c":1}} trailer'
        obj = json.loads(sc._strip_noise(raw))
        self.assertEqual(obj["a"], "} tricky")


    def test_find_files_bun_flat_no_wrapper(self):
        # Newer Bun can emit {summary, files} without a `coverage` wrapper.
        doc = {"summary": {"percent": 0.9, "coveredLines": 9, "totalLines": 10},
               "files": [{"path": "src/lib/foo.ts", "lineCount": 10, "coveredLines": 9}]}
        files, totals = sc._find_files_and_totals(doc)
        self.assertEqual(len(files), 1)
        self.assertEqual(totals["coveredLines"], 9)


class TestPercentRecompute(unittest.TestCase):
    def test_pct_from_counts(self):
        self.assertAlmostEqual(sc._pct(100, 90), 90.0)
        self.assertAlmostEqual(sc._pct(0, 0), 0.0)
        self.assertAlmostEqual(sc._pct(7, 3), (3 / 7) * 100)

    def test_rs_report_recomputes_overall_not_trusting_stored(self):
        rep = sc.build_rs_report(CARGO_FLAT, "server")
        # Counts: 90+20+60=170 / 100+50+60=210 → 80.952%, not the stored 80.95
        self.assertEqual(rep.total_lines, 210)
        self.assertEqual(rep.covered_lines, 170)
        self.assertAlmostEqual(rep.pct, (170 / 210) * 100, places=2)


class TestRustBuckets(unittest.TestCase):
    def test_crate_bucket_from_path(self):
        self.assertEqual(sc._bucket_rust("h-storage-duckdb/src/exchanges.rs", "server"), "h-storage-duckdb")
        self.assertEqual(sc._bucket_rust("h-common/src/lib.rs", "server"), "h-common")

    def test_app_crate_bucket(self):
        self.assertEqual(sc._bucket_rust("app/heron/src/main.rs", "server"), "app")

    def test_other_bucket_for_non_crate(self):
        self.assertEqual(sc._bucket_rust("target/whatever.rs", "server"), "<other>")

    def test_report_groups_by_crate(self):
        rep = sc.build_rs_report(CARGO_FLAT, "server")
        self.assertIn("h-common", rep.buckets)
        self.assertIn("h-llm", rep.buckets)
        self.assertIn("h-storage-duckdb", rep.buckets)


class TestTSDenominator(unittest.TestCase):
    def _write_tree(self, tree: dict[str, str]) -> str:
        d = tempfile.mkdtemp(prefix="cov_test_")
        for rel, content in tree.items():
            full = os.path.join(d, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as fh:
                fh.write(content)
        return d

    def test_excludes_test_spec_files(self):
        d = self._write_tree({
            "src/lib/foo.ts": "a\nb\n",
            "src/lib/foo.test.ts": "c\nd\n",
            "src/lib/bar.spec.tsx": "e\nf\n",
        })
        entries = sc._ts_denominator_entries(os.path.join(d, "src"))
        names = sorted(os.path.basename(e) for e in entries)
        self.assertEqual(names, ["foo.ts"])

    def test_excludes_fixture_and_mock_dirs(self):
        d = self._write_tree({
            "src/lib/real.ts": "a\n",
            "src/lib/__fixtures__/sample.ts": "b\n",
            "src/lib/wire-apis/openai-chat/__fixtures__/case.ts": "c\n",
            "src/lib/__mocks__/thing.ts": "d\n",
        })
        entries = sc._ts_denominator_entries(os.path.join(d, "src"))
        names = sorted(os.path.relpath(e, os.path.join(d, "src")) for e in entries)
        self.assertEqual(names, ["lib/real.ts"])

    def test_excludes_ambient_dts(self):
        d = self._write_tree({
            "src/vite-env.d.ts": "declare {}\n",
            "src/types.ts": "x\n",
        })
        entries = sc._ts_denominator_entries(os.path.join(d, "src"))
        names = [os.path.basename(e) for e in entries]
        self.assertEqual(names, ["types.ts"])

    def test_uninstrumented_file_counts_as_gap(self):
        # Bun reports foo.ts but never touches bar.ts → bar.ts must enter the
        # denominator with its real line count and 0 covered.
        bun = {"coverage": {"files": [
            {"path": "src/lib/foo.ts", "lineCount": 4, "coveredLines": 4},
        ], "summary": {}}}
        d = self._write_tree({
            "src/lib/foo.ts": "a\nb\nc\nd\n",
            "src/lib/bar.ts": "x\ny\nz\n",  # 3 lines, never reported
        })
        rep = sc.build_ts_report(bun, os.path.join(d, "src"), d)
        # foo: 4/4, bar: 0/3 → 4/7 ≈ 57.1%
        self.assertEqual(rep.total_lines, 7)
        self.assertEqual(rep.covered_lines, 4)
        self.assertAlmostEqual(rep.pct, (4 / 7) * 100, places=1)

    def test_bun_report_excludes_test_files_from_denominator(self):
        # The test file Bun *did* report must NOT contribute to either side.
        rep = sc.build_ts_report(BUN_REPORT, "<nonexistent>", "<nonexistent>")
        # foo.ts 40/30 + baz.tsx 10/9 = 50/50 covered; bar.test.ts excluded.
        self.assertEqual(rep.total_lines, 50)
        self.assertEqual(rep.covered_lines, 39)


class TestWorstUncovered(unittest.TestCase):
    def test_orders_by_gap_then_pct(self):
        rep = sc.CoverageReport()
        rep.add("c", "a.rs", 100, 50)   # gap 50, 50%
        rep.add("c", "b.rs", 60, 0)     # gap 60, 0%
        rep.add("c", "c.rs", 10, 0)     # gap 10, 0%
        worst = rep.worst_uncovered(2)
        self.assertEqual([w[0] for w in worst], ["b.rs", "a.rs"])

    def test_worst_uncovered_handles_fully_covered(self):
        rep = sc.CoverageReport()
        rep.add("c", "full.rs", 10, 10)  # gap 0
        rep.add("c", "half.rs", 10, 5)   # gap 5
        worst = rep.worst_uncovered(5)
        self.assertEqual(worst[0][0], "half.rs")
        self.assertEqual(worst[0][3], 50.0)


class TestCLI(unittest.TestCase):
    def test_gate_exit_zero_when_above_min(self):
        # 90/100 = 90% ≥ 90 gate
        doc = {"files": [{"filename": "h-common/src/lib.rs",
                          "summary": {"lines": {"count": 100, "covered": 90}}}], "totals": {}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(doc, f)
            path = f.name
        rc = sc.main(["--kind", "rs", "--json-file", path, "--gate", "--min", "90", "--no-gap-list"])
        os.unlink(path)
        self.assertEqual(rc, 0)

    def test_gate_exit_one_when_below_min(self):
        doc = {"files": [{"filename": "h-common/src/lib.rs",
                          "summary": {"lines": {"count": 100, "covered": 80}}}], "totals": {}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(doc, f)
            path = f.name
        rc = sc.main(["--kind", "rs", "--json-file", path, "--gate", "--min", "90", "--no-gap-list"])
        os.unlink(path)
        self.assertEqual(rc, 1)

    def test_text_log_written_without_ansi(self):
        doc = {"files": [{"filename": "h-common/src/lib.rs",
                          "summary": {"lines": {"count": 100, "covered": 90}}}], "totals": {}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(doc, f)
            path = f.name
        log = path + ".txt"
        rc = sc.main(["--kind", "rs", "--json-file", path, "--text-log", log, "--no-gap-list"])
        self.assertEqual(rc, 0)
        with open(log) as fh:
            content = fh.read()
        self.assertNotIn("\033[", content)
        self.assertIn("Coverage", content)
        os.unlink(path)
        os.unlink(log)


if __name__ == "__main__":
    unittest.main(verbosity=2)

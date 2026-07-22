#!/usr/bin/env bash
# Rust workspace coverage via cargo-llvm-cov — a MERGED report.
#
# Up to three instrumented runs feed one merged report, so a feature-gated
# suite can contribute without forcing that feature on for every crate:
#
#   1. `cargo llvm-cov test --workspace --no-report`           (default features)
#   2. `cargo llvm-cov test -p h-storage-duckdb \
#          --features fault-injection --no-report`              (gated suite)
#   3. `cargo llvm-cov test -p h-capture \
#          --features ebpf --no-report`                          (eBPF userspace)
#
# Run 3 is Linux-only and best-effort: building h-capture with `--features ebpf`
# compiles the BPF program out-of-band (build.rs → `rustup run nightly …
# bpfel-unknown-none` + `bpf-linker`), so it only runs when the nightly BPF
# toolchain is installed. Its host unit tests are the eBPF *userspace* contract
# (the pure decoder/offset/synth helpers live in always-compiled modules that
# run 1 already instruments; run 3 catches anything that lands behind the
# feature later). It is merged only when it actually builds — otherwise it is
# skipped with a one-line notice (the "when they add measurable lines" gate).
#
# eBPF measurement exception: the aya loader (`h-capture/src/ebpf/source.rs`)
# is environment-gated integration code — it needs `CAP_BPF` + the BPF toolchain
# to even build and has no host unit tests — so it is EXCLUDED from the report
# (`--ignore-filename-regex`), never dragging the gate down. The pure layout
# (`h-ebpf-common`), the decoder, the offset resolver, and the synthesizer are
# NOT excluded; they are the host-tested contract. See
# `server/h-ebpf-prog/README.md` for the BPF inventory + residual-line list and
# `docs/design/02-capture.md` § "Testability split".
#
# `--no-report` accumulates profraw into server/target/llvm-cov/ without
# printing a report; `cargo llvm-cov merge` folds all profraw sets together;
# `cargo llvm-cov report --json --summary-only` emits the merged numbers.
# `cargo-llvm-cov` must be installed (`cargo install cargo-llvm-cov --locked`).
#
# Outputs live under gitignored server/target/llvm-cov/ (never committed).
# The merged JSON is piped through summarize_coverage.py for the line-% +
# per-crate + worst-uncovered summary.
set -euo pipefail

BLUE='\033[0;34m'
BOLD='\033[1m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$PROJECT_ROOT" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
cd "$PROJECT_ROOT"

SERVER_DIR="server"
OUT_DIR="$SERVER_DIR/target/llvm-cov"
JSON_OUT="$OUT_DIR/coverage.json"
TEXT_LOG="$OUT_DIR/coverage.txt"
SUMMARY_PY="$PROJECT_ROOT/scripts/coverage/lib/summarize_coverage.py"
HERON_COV_MIN="${HERON_COV_MIN:-90}"
GATE="${HERON_COV_GATE:-0}"

# eBPF measurement exception: the aya loader is environment-gated integration
# code (CAP_BPF + the BPF toolchain to build; no host unit tests), so it is
# excluded from the coverage report. Everything else in the eBPF path — the
# shared layout, the decoder, the offset resolver, the synthesizer — IS host
# tested and stays in the report.
EBPF_IGNORE='ebpf/source\.rs$'

usage() {
    echo ""
    echo "🧪 just test coverage rs   Rust workspace coverage (cargo-llvm-cov, merged)"
    echo ""
    echo "   Merges up to 3 runs: workspace (default), h-storage-duckdb"
    echo "   --features fault-injection, and h-capture --features ebpf (Linux +"
    echo "   the nightly BPF toolchain only; skipped otherwise)."
    echo ""
    echo "   eBPF measurement exception: h-capture/src/ebpf/source.rs (the aya"
    echo "   loader) is excluded — it needs CAP_BPF + the BPF toolchain to build"
    echo "   and has no host unit tests. The pure eBPF layout/decoder/offset/"
    echo "   synth modules are NOT excluded (host-tested contract)."
    echo ""
    echo "   Env:"
    echo "     HERON_COV_MIN=<pct>   gate threshold (default 90)"
    echo "     HERON_COV_GATE=1      exit 1 if coverage < threshold (default: report-only)"
    echo "     HERON_COV_EBPF=0      skip the eBPF-feature run even on a BPF host (default: auto)"
    echo ""
}

# ── preflight ──────────────────────────────────────────────────────────────
if ! command -v cargo >/dev/null 2>&1; then
    echo -e "${RED}✗ cargo not found on PATH${NC}" >&2
    exit 1
fi
if ! cargo llvm-cov --version >/dev/null 2>&1; then
    echo -e "${RED}✗ cargo-llvm-cov not installed.${NC}" >&2
    echo -e "  Install with:  cargo install cargo-llvm-cov --locked" >&2
    echo -e "  (also needs the llvm-tools-preview rustup component)" >&2
    exit 1
fi
rustup component add llvm-tools-preview >/dev/null 2>&1 || true

mkdir -p "$OUT_DIR"

# ── run 1: workspace, default features ─────────────────────────────────────
echo -e "${BLUE}[rs] cargo llvm-cov test --workspace (default features)${NC}"
(
    cd "$SERVER_DIR"
    cargo llvm-cov test --workspace --no-report --quiet
)

# ── run 2: fault-injection suite (the gated concurrent_tests) ─────────────
# The fault-injection code is #[cfg(feature = "fault-injection")] so only THIS
# run instruments it; the merge below folds both profraw sets into one report.
echo -e "${BLUE}[rs] cargo llvm-cov test -p h-storage-duckdb --features fault-injection${NC}"
(
    cd "$SERVER_DIR"
    cargo llvm-cov test -p h-storage-duckdb --features fault-injection --no-report --quiet
)

# ── run 3: eBPF userspace unit tests (Linux + nightly BPF toolchain) ───────
# `--features ebpf` compiles the BPF program out-of-band (build.rs), so this
# only runs where the nightly toolchain + bpf-linker are installed. Best-effort:
# a build failure (no/missing toolchain) is logged and skipped — it must not
# fail the coverage run. The eBPF userspace contract (decode/offsets/synth) is
# already instrumented by run 1 (always-compiled modules); this run catches
# anything that lands behind the feature later and is merged only when it
# builds ("when they add measurable lines"). Disable explicitly with
# HERON_COV_EBPF=0.
ebpf_toolchain_ready() {
    [ "$(uname -s)" = "Linux" ] || return 1
    [ "${HERON_COV_EBPF:-1}" != "0" ] || return 1
    # Cheap fast-path so a host without the BPF toolchain doesn't attempt a
    # long doomed compile. build.rs needs: the nightly toolchain (for
    # `-Z build-std=core` + rust-src) and bpf-linker. `bpfel-unknown-none` is a
    # built-in rustc target (used with build-std), so it is NOT `rustup target
    # add`'d — we don't (and can't) check `rustup target list --installed`.
    rustup toolchain list 2>/dev/null | grep -q nightly || return 1
    command -v bpf-linker >/dev/null 2>&1 || return 1
    return 0
}

if ebpf_toolchain_ready; then
    echo -e "${BLUE}[rs] cargo llvm-cov test -p h-capture --features ebpf (userspace, Linux)${NC}"
    if (cd "$SERVER_DIR" && cargo llvm-cov test -p h-capture --features ebpf --no-report --quiet); then
        echo -e "${DIM}[rs] eBPF-feature run merged${NC}"
    else
        echo -e "${DIM}[rs] eBPF-feature run skipped (build failed — BPF toolchain incomplete); pure userspace ebpf tests already in run 1${NC}"
    fi
else
    echo -e "${DIM}[rs] eBPF-feature run skipped (not Linux / BPF toolchain not installed); pure userspace ebpf tests already in run 1${NC}"
fi

# ── merge all profraw runs, then emit the merged report ────────────────────
# `merge --no-report` folds every run's profraw into one profdata;
# `--ignore-run-version` tolerates the recompiles the feature runs force.
# The report step drops the aya loader (`ebpf/source.rs`) via
# --ignore-filename-regex — the eBPF measurement exception (see header).
echo -e "${BLUE}[rs] cargo llvm-cov merge → report${NC}"
(
    cd "$SERVER_DIR"
    cargo llvm-cov merge --no-report --ignore-run-version >/dev/null
    cargo llvm-cov report --json --summary-only \
        --ignore-filename-regex "$EBPF_IGNORE" >"$PROJECT_ROOT/$JSON_OUT"
)

# Also write a human text report (raw llvm-cov text view) alongside the JSON.
(
    cd "$SERVER_DIR"
    cargo llvm-cov report --text --ignore-filename-regex "$EBPF_IGNORE" \
        2>/dev/null >"$OUT_DIR/coverage-raw.txt" || true
)

# ── summarize ──────────────────────────────────────────────────────────────
GATE_FLAG=""
if [ "$GATE" = "1" ]; then
    GATE_FLAG="--gate"
fi

python3 "$SUMMARY_PY" \
    --kind rs \
    --json-file "$JSON_OUT" \
    --text-log "$TEXT_LOG" \
    --min "$HERON_COV_MIN" \
    --top 20 \
    $GATE_FLAG

echo -e "${DIM}artifacts: $JSON_OUT${NC}"
echo -e "${DIM}          $TEXT_LOG${NC}"

#!/usr/bin/env bash
# Rust workspace coverage via cargo-llvm-cov — a MERGED report.
#
# Two instrumented runs feed one merged report (so the `fault-injection`-gated
# concurrent_tests in h-storage-duckdb contribute without forcing that
# feature on for every crate):
#
#   1. `cargo llvm-cov test --workspace --no-report`           (default features)
#   2. `cargo llvm-cov test -p h-storage-duckdb \
#          --features fault-injection --no-report`              (gated suite)
#
# `--no-report` accumulates profraw into server/target/llvm-cov/ without
# printing a report; `cargo llvm-cov merge` folds both profraw sets together;
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

usage() {
    echo ""
    echo "🧪 just test coverage rs   Rust workspace coverage (cargo-llvm-cov, merged)"
    echo ""
    echo "   Env:"
    echo "     HERON_COV_MIN=<pct>   gate threshold (default 90)"
    echo "     HERON_COV_GATE=1      exit 1 if coverage < threshold (default: report-only)"
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

# ── merge the two profraw runs, then emit the merged report ─────────────────
# `merge --no-report` folds both runs' profraw into one profdata; `--ignore-run-version`
# tolerates the recompile the fault-injection feature forces on h-storage-duckdb.
echo -e "${BLUE}[rs] cargo llvm-cov merge → report${NC}"
(
    cd "$SERVER_DIR"
    cargo llvm-cov merge --no-report --ignore-run-version >/dev/null
    cargo llvm-cov report --json --summary-only >"$PROJECT_ROOT/$JSON_OUT"
)

# Also write a human text report (raw llvm-cov text view) alongside the JSON.
(
    cd "$SERVER_DIR"
    cargo llvm-cov report --text 2>/dev/null >"$OUT_DIR/coverage-raw.txt" || true
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

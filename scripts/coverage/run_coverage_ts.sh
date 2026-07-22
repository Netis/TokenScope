#!/usr/bin/env bash
# Console (frontend) coverage via `bun test --coverage`.
#
# Bun emits two reporters: `text` (to stdout, for the developer) and `json`
# (to a file under --coverage-dir). Bun's own aggregate totals include the
# very test/fixture files the gate must NOT count, so this script does NOT
# trust them — it pipes the JSON through summarize_coverage.py, which walks
# console/src/**/*.{ts,tsx} itself (excluding .test./.spec./__fixtures__/
# fixtures/__mocks__/.d.ts) and recomputes the denominator from raw counts.
#
# A source file Bun never instrumented (a leaf module no test touches) enters
# the denominator with its real line count and zero covered — the honest gap.
#
# Outputs live under gitignored console/coverage/ (never committed).
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

CONSOLE_DIR="console"
COV_DIR="$CONSOLE_DIR/coverage"
TEXT_LOG="$COV_DIR/coverage.txt"
SUMMARY_PY="$PROJECT_ROOT/scripts/coverage/lib/summarize_coverage.py"
HERON_COV_MIN="${HERON_COV_MIN:-90}"
GATE="${HERON_COV_GATE:-0}"

usage() {
    echo ""
    echo "🧪 just test coverage ts   Console coverage (bun test --coverage)"
    echo ""
    echo "   Env:"
    echo "     HERON_COV_MIN=<pct>   gate threshold (default 90)"
    echo "     HERON_COV_GATE=1      exit 1 if coverage < threshold (default: report-only)"
    echo ""
}

# ── preflight ──────────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
    echo -e "${RED}✗ bun not found on PATH${NC}" >&2
    exit 1
fi
mkdir -p "$COV_DIR"

# ── run ─────────────────────────────────────────────────────────────────────
# Both reporters: json → file (parsed below), text → stdout (live view).
echo -e "${BLUE}[ts] bun test --coverage${NC}"
(
    cd "$CONSOLE_DIR"
    bun test --coverage \
        --coverage-reporter=text \
        --coverage-reporter=json \
        --coverage-dir="$PROJECT_ROOT/$COV_DIR"
)

# ── locate the JSON report Bun wrote ───────────────────────────────────────
# Bun's JSON filename has varied across versions (bun-coverage.json /
# coverage.json). Pick the newest .json in the coverage dir.
JSON_OUT=""
JSON_OUT="$(find "$COV_DIR" -maxdepth 2 -name '*.json' -type f -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$JSON_OUT" ]; then
    echo -e "${RED}✗ no coverage JSON found under $COV_DIR${NC}" >&2
    echo -e "  (did bun write the json reporter to a different path?)" >&2
    exit 1
fi

# ── summarize (summarizer enforces the denominator itself) ──────────────────
GATE_FLAG=""
if [ "$GATE" = "1" ]; then
    GATE_FLAG="--gate"
fi

python3 "$SUMMARY_PY" \
    --kind ts \
    --json-file "$JSON_OUT" \
    --text-log "$TEXT_LOG" \
    --console-root "$CONSOLE_DIR" \
    --min "$HERON_COV_MIN" \
    --top 20 \
    $GATE_FLAG

echo -e "${DIM}artifacts: $JSON_OUT${NC}"
echo -e "${DIM}          $TEXT_LOG${NC}"

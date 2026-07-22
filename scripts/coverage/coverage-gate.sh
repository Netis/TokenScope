#!/usr/bin/env bash
# Local coverage GATE — runs both stacks with HERON_COV_GATE=1 and fails the
# shell if either is below HERON_COV_MIN (default 90).
#
# This is for local pre-push hygiene. CI does NOT use this: ci.yml's `coverage`
# job is report-only (continue-on-error on the run steps + a threshold step
# with `shell: bash {0}` so the percentage always surfaces even when below the
# baseline). Keeping the local gate hard while CI stays soft means coverage
# drops are *visible* in CI but never *block* a PR solely because % ≤ 90.
#
#   just test coverage gate            run the gate (rs + ts)
#   HERON_COV_MIN=<pct> just test coverage gate   change threshold
set -euo pipefail

BLUE='\033[0;34m'
RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$PROJECT_ROOT" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
cd "$PROJECT_ROOT"

export HERON_COV_MIN="${HERON_COV_MIN:-90}"
export HERON_COV_GATE=1

RC=0
echo -e "${BOLD}${BLUE}🚪 coverage gate (threshold ${HERON_COV_MIN}%)${NC}"
echo ""

echo -e "${BLUE}━━━ Rust ━━━${NC}"
if bash scripts/coverage/run_coverage_rs.sh; then
    echo -e "${GREEN}✓ rs gate passed${NC}"
else
    echo -e "${RED}✗ rs gate failed${NC}" >&2
    RC=1
fi
echo ""

echo -e "${BLUE}━━━ TypeScript ━━━${NC}"
if bash scripts/coverage/run_coverage_ts.sh; then
    echo -e "${GREEN}✓ ts gate passed${NC}"
else
    echo -e "${RED}✗ ts gate failed${NC}" >&2
    RC=1
fi
echo ""

if [ "$RC" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✓ coverage gate passed (${HERON_COV_MIN}% on both stacks)${NC}"
else
    echo -e "${RED}${BOLD}✗ coverage gate failed (see above)${NC}" >&2
fi
exit "$RC"

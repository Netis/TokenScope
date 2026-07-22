#!/usr/bin/env bash
set -euo pipefail

BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$PROJECT_ROOT" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
fi
cd "$PROJECT_ROOT"

show_help() {
    echo ""
    echo "🧪 Testing"
    echo "   just test all             Run cargo test (all workspace crates)"
    echo "   just test rs [filter]     cargo test (optional filter)"
    echo "   just test ts              bun test in console/"
    echo "   just test crate <name>    Test a single workspace crate"
    echo ""
    echo "📊 Coverage (cargo-llvm-cov + bun test --coverage)"
    echo "   just test coverage         Both stacks, report-only (no gate)"
    echo "   just test coverage rs       Rust only (merged report incl. fault-injection)"
    echo "   just test coverage ts       Console only (denominator over src/**)"
    echo "   just test coverage gate     Hard-fail if either < HERON_COV_MIN (default 90)"
    echo ""
    echo "   eBPF measurement exception: the Rust run also attempts a"
    echo "   --features ebpf userspace run on Linux (nightly BPF toolchain only;"
    echo "   skipped otherwise). The aya loader (h-capture/src/ebpf/source.rs) is"
    echo "   excluded from the report — it needs CAP_BPF + the BPF toolchain to"
    echo "   build and has no host unit tests. The pure eBPF layout/decoder/"
    echo "   offset/synth modules are NOT excluded (host-tested contract). See"
    echo "   server/h-ebpf-prog/README.md for the BPF inventory + residual lines."
}

run_rs() {
    echo -e "${BLUE}[rs] cargo test${NC}"
    (cd server && cargo test "$@")
}

run_ts() {
    echo -e "${BLUE}[ts] bun test${NC}"
    (cd console && bun test "$@")
}

run_crate() {
    local name="${1:-}"
    if [ -z "$name" ]; then echo "Usage: just test crate <name>" >&2; exit 1; fi
    shift
    echo -e "${BLUE}[rs] cargo test -p $name${NC}"
    (cd server && cargo test -p "$name" "$@")
}

# Coverage (cargo-llvm-cov for Rust, bun test --coverage for TS).
# `just test coverage [rs|ts|gate]` — the gate hard-fails locally below
# HERON_COV_MIN (default 90); plain `coverage`/`rs`/`ts` are report-only.
run_coverage() {
    local sub="${1:-all}"
    case "$sub" in
        all|"")
            # Both stacks, report-only (no gate). The gate script is only used
            # for the explicit `gate` sub-command so it can hard-fail.
            bash scripts/coverage/run_coverage_rs.sh
            bash scripts/coverage/run_coverage_ts.sh
            ;;
        rs|rust)
            shift 2>/dev/null || true
            bash scripts/coverage/run_coverage_rs.sh "$@"
            ;;
        ts|typescript)
            shift 2>/dev/null || true
            bash scripts/coverage/run_coverage_ts.sh "$@"
            ;;
        gate)
            bash scripts/coverage/coverage-gate.sh
            ;;
        *)
            echo "Unknown coverage sub-command: $sub" >&2
            echo "Run 'just test coverage' for help." >&2
            exit 1
            ;;
    esac
}

ACTION="${1:-help}"
shift 2>/dev/null || true

case "$ACTION" in
    all) run_rs "$@" ;;
    rs|rust|server) run_rs "$@" ;;
    ts|typescript|console) run_ts "$@" ;;
    crate|pkg|p) run_crate "$@" ;;
    coverage|cov) run_coverage "$@" ;;
    help|--help|-h) show_help ;;
    *) echo "Unknown: $ACTION. Run 'just test' for help."; exit 1 ;;
esac

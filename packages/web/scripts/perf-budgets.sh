#!/usr/bin/env bash
# The exact counts behind the perf benches (packages/web/perf/README.md): a
# warm conversation switch fetches no history, the 5,000-session inbox draws a
# bounded list and a heartbeat re-renders none of it, a long diff opens in one
# commit with no layout read, and a warm switch, a diff panel toggle and a send
# each force layout at most once (perf/forcedLayouts.ts). Counts, so a slow
# machine passes the same as a fast one; it only takes longer.
set -euo pipefail
cd "$(dirname "$0")/.."
bun perf/budgets.ts
for workload in switch diff-toggle send; do bun perf/forcedLayouts.ts "$workload"; done

#!/usr/bin/env bash
# The exact counts behind the perf benches (packages/web/perf/README.md): a
# warm conversation switch fetches no history, the 5,000-session inbox draws a
# bounded list and a heartbeat re-renders none of it, a long diff opens in one
# commit with no layout read. Counts, so a slow machine passes the same as a
# fast one; it only takes longer.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun perf/budgets.ts

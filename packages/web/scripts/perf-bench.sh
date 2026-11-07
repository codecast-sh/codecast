#!/usr/bin/env bash
# A/B benches of the web app's hot paths (packages/web/perf/README.md), run
# with strobe at a pinned version. Every flag passes through to `strobe bench`.
#   scripts/perf-bench.sh                          # origin/main vs this tree, every case
#   scripts/perf-bench.sh --filter "open a long diff"
#   scripts/perf-bench.sh --base <ref>             # another base
#   scripts/perf-bench.sh --check                  # each case once: does it still run?
#   scripts/perf-bench.sh --aa                     # this tree on both sides: is the method sound here?
# Timing on a machine whose CPUs are already busy only widens the intervals
# until nothing decides, so a timed run refuses one: PERF_ALLOW_BUSY=1 runs
# anyway (strobe still reports the load beside the verdict).
set -euo pipefail
STROBE_VERSION=0.17.0
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

args=("$@")
has() { for a in "${args[@]+"${args[@]}"}"; do case "$a" in "$1"|"$1"=*) return 0 ;; esac; done; return 1; }
has --head || args+=(--head .)
has --base || has --aa || has --check || args+=(--base origin/main)

if ! has --check && [ "${PERF_ALLOW_BUSY:-}" != 1 ]; then
  busy="$(bun -e 'const os=require("os");console.log((os.loadavg()[0]/os.cpus().length).toFixed(2))')"
  if bun -e "process.exit(${busy} > 1 ? 0 : 1)"; then
    echo "perf-bench: load is ${busy}x the CPU count; timings here would not decide. Set PERF_ALLOW_BUSY=1 to run anyway." >&2
    exit 2
  fi
fi

exec bunx "@hona/strobe@${STROBE_VERSION}" bench packages/web/perf/web.bench.ts "${args[@]}"

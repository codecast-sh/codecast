#!/bin/bash
# One matrix claude mid-turn delivery per iteration, each against a daemon log
# of its own, so every drain decision is attributable to the run that made it.
# Usage: matrix-attrib.sh <label> <iterations> <daemon-snapshot>
cd "$(dirname "$0")" || exit 1
label="$1"; iters="${2:-8}"; snapshot="$3"
out="/tmp/ct49750-attrib-$label"
log="${TMPDIR:-/tmp}/codecast-test-daemon.log"
mkdir -p "$out"
cp "$snapshot" src/daemon.ts || exit 1
for i in $(seq 1 "$iters"); do
  : > "$log"
  timeout 900 bun test src/messaging.e2e.test.ts -t "claude" > "$out/run$i.log" 2>&1
  cp "$log" "$out/daemon$i.log"
  # Only real matrix panes: the unit suites drive a fake `t:0.0`.
  repaste=$(grep -c 'cc-matrix-test.*draining and re-pasting' "$out/daemon$i.log")
  empty=$(grep -c 'composer still empty after paste in cc-matrix-test' "$out/daemon$i.log")
  skip=$(grep -c 'Composer in cc-matrix-test.*skipping the clearing keys' "$out/daemon$i.log")
  verdict=$(grep -E '^ +[0-9]+ (pass|fail)' "$out/run$i.log" | tr -d '\n')
  echo "iter $i:$verdict | gate re-pastes=$repaste (empty-branch=$empty) drain-skips=$skip"
done

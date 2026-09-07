#!/bin/bash
# The after side, in one go: the forced re-paste-branch probe, then the D0
# matrix's three claude cells, then the unit suites.
cd "$(dirname "$0")" || exit 1
S=/tmp/ct49750-patch/daemon.after.ts
./probe-runs.sh after 6 "$S"
./matrix-runs.sh after 6 "$S"
cp "$S" src/daemon.ts
echo "=== unit suites (after) ==="
bun test src/daemon.inject-enter-gate.test.ts src/daemon.machine-prompt-safety.test.ts 2>&1 | tail -12
echo AFTER-PHASE-COMPLETE

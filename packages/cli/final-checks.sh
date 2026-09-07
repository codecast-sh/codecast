#!/bin/bash
# Everything that has to be green before this lands, against the after tree.
cd "$(dirname "$0")" || exit 1
out=/tmp/ct49750-final
mkdir -p "$out"
echo "=== tsc ==="
npx tsc --noEmit -p tsconfig.typecheck.json 2>&1 | tail -5
echo "=== unit: enter gate + machine-prompt-safety + submit-verify ==="
bun test src/daemon.inject-enter-gate.test.ts src/daemon.machine-prompt-safety.test.ts src/daemon.inject-submit-verify.test.ts > "$out/units.log" 2>&1
tail -6 "$out/units.log"
echo "=== bench (the harness merge's other caller) ==="
bun test src/bench/fixture.test.ts src/bench/integration.test.ts > "$out/bench.log" 2>&1
tail -6 "$out/bench.log"
echo "=== ct-49753 gate: inject-clear, six runs ==="
for i in 1 2 3 4 5 6; do
  timeout 900 bun test src/daemon.inject-clear.test.ts > "$out/clear$i.log" 2>&1
  echo "  run $i: $(grep -E '^ +[0-9]+ (pass|fail)' "$out/clear$i.log" | tr -d '\n')"
done
echo FINAL-CHECKS-COMPLETE

#!/usr/bin/env bash
# The typing budget, run before every ship that touches web, shared or platform
# code (.codecast/workspace.toml) and in CI with the rest of the web tests.
# Each test holds one cause of slow typing in the composer to its budget:
#   composerTypingBudget  a keystroke commits once, writes nothing to the store,
#                         changes no DOM outside the textarea (7,000 sessions)
#   storeWriteBudget      no store subscription compares a long string; a write
#                         nothing reads, or a heartbeat, re-renders nothing
#   listRowsHoldStill     list rows run no infinite animation
#   transcriptRowsNoLayers  transcript rows are not compositor layers
#   keys dispatch         a typed key that matches no shortcut never queries the DOM
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root/packages/web"
bun test --isolate \
  components/__tests__/composerTypingBudget.mount.test.tsx \
  store/__tests__/storeWriteBudget.mount.test.tsx \
  components/__tests__/listRowsHoldStill.test.tsx \
  components/__tests__/transcriptRowsNoLayers.guard.test.ts \
  hooks/__tests__/useConvexSync.typingDefer.mount.test.tsx \
  lib/__tests__/inputQuiet.test.ts
cd "$root/platform/packages/keys"
bun test src/dispatch.test.ts

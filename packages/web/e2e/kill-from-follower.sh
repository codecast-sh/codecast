#!/bin/bash
# E2E: a kill made in a FOLLOWER window stays killed in every window on both
# devices, survives a reload, and a restore made on the other device reaches
# every window — with no reconcile crawl in the client (ct-47927).
#
# Rig: one Chrome (the shared agent browser), two origins on the same vite
# dev server = two "devices" with separate IndexedDB (A = localhost, B =
# 127.0.0.1), two tabs on A (host + follower) and one on B, all signed in as
# the App Review demo account with minted token pairs. Drive with the CLI's
# `tab <ref>` + `eval --stdin`; every probe reads the dev store handle.
#
# Setup (once per run), from packages/web:
#   1. mint a token pair per origin for the demo account (App Review "Jordan Lee"):
#      (cd ../convex && env -u CONVEX_DEPLOYMENT npx convex run auth:store \
#        '{"args":{"type":"signIn","userId":"<users _id>","generateTokens":true}}' > /tmp/e2e-tokens.json)
#      and again into /tmp/e2e-tokens-b.json for the second origin
#   2. `bun run e2e/seed.ts 3` prints three conversation ids (each with two messages)
#   3. start vite on a free port (`./node_modules/.bin/vite --port 3201 --strictPort`),
#      open <origin>/robots.txt in a tab per origin, set localStorage
#      `__convexAuthJWT_httpsconvexcodecastsh` + `__convexAuthRefreshToken_httpsconvexcodecastsh`
#      from the pair, then open <origin>/inbox; open a second tab on origin A
#      (it becomes the follower: `window.__syncReplication()` reports synced)
#   4. run this script; `bun run e2e/cleanup.ts` deletes the seeded rows afterwards
#
#   usage: kill-from-follower.sh <A-host tab> <A-follower tab> <B-host tab> <conversation id>
set -euo pipefail
A_HOST=$1; A_W1=$2; B_HOST=$3; ID=$4
W=${CODECAST_WORKTREE:-$(cd "$(dirname "$0")/../../.." && pwd)}
CB="bun $W/packages/cli/src/index.ts browser"
cd "$W/packages/cli"

probe() { # <tab> — the row's stamps, whether it is rendered, the window's role
  $CB tab "$1" >/dev/null 2>&1
  $CB eval --stdin --timeout 30000 <<JS 2>&1 | tail -1
const ID = "$ID";
for (let i = 0; i < 40; i++) { const st = window.__inboxStore?.getState?.(); if (st?.clientStateInitialized && st.currentUser?._id) break; await new Promise(r => setTimeout(r, 500)); }
const st = window.__inboxStore.getState();
const s = st.sessions[ID];
const shown = st.sortedSessions().some((r) => r._id === ID);
JSON.stringify({ tab: "$1", role: st.syncRole, killed: s?.inbox_killed_at ?? null, dismissed: s?.inbox_dismissed_at ?? null, shown, cached: !!s })
JS
}

expect_hidden() { # <tab> <label> — poll until the row leaves the rendered set
  $CB tab "$1" >/dev/null 2>&1
  $CB eval --stdin --timeout 45000 <<JS 2>&1 | tail -1
const ID = "$ID";
let out = null;
for (let i = 0; i < 60; i++) {
  const st = window.__inboxStore.getState();
  const s = st.sessions[ID];
  const shown = st.sortedSessions().some((r) => r._id === ID);
  out = { tab: "$1", when: "$2", role: st.syncRole, killed: s?.inbox_killed_at ?? null, dismissed: s?.inbox_dismissed_at ?? null, shown };
  if (!shown && out.dismissed) break;
  await new Promise(r => setTimeout(r, 500));
}
JSON.stringify(out)
JS
}

expect_shown() { # <tab> <label> — poll until the row is rendered again
  $CB tab "$1" >/dev/null 2>&1
  $CB eval --stdin --timeout 45000 <<JS 2>&1 | tail -1
const ID = "$ID";
let out = null;
for (let i = 0; i < 60; i++) {
  const st = window.__inboxStore.getState();
  const s = st.sessions[ID];
  const shown = st.sortedSessions().some((r) => r._id === ID);
  out = { tab: "$1", when: "$2", role: st.syncRole, killed: s?.inbox_killed_at ?? null, dismissed: s?.inbox_dismissed_at ?? null, shown };
  if (shown && !out.dismissed && !out.killed) break;
  await new Promise(r => setTimeout(r, 500));
}
JSON.stringify(out)
JS
}

echo "## before"
for t in "$A_HOST" "$A_W1" "$B_HOST"; do probe "$t"; done

echo "## kill from the follower ($A_W1)"
$CB tab "$A_W1" >/dev/null 2>&1
$CB eval --stdin --timeout 10000 <<JS 2>&1 | tail -1
const st = window.__inboxStore.getState();
st.killSession("$ID");
JSON.stringify({ role: st.syncRole, dispatchWired: st._isDispatchWired?.() ?? null })
JS

echo "## within seconds: hidden everywhere"
expect_hidden "$A_W1" "after-kill"
expect_hidden "$A_HOST" "after-kill"
expect_hidden "$B_HOST" "after-kill"

echo "## 25s later (past the old crawl latency): still hidden everywhere"
sleep 25
for t in "$A_HOST" "$A_W1" "$B_HOST"; do probe "$t"; done

echo "## reload A-host: still hidden"
$CB tab "$A_HOST" >/dev/null 2>&1
$CB open "http://localhost:3201/inbox" >/dev/null 2>&1
expect_hidden "$A_HOST" "after-reload"

echo "## restore from B-host"
$CB tab "$B_HOST" >/dev/null 2>&1
$CB eval --stdin --timeout 10000 <<JS 2>&1 | tail -1
window.__inboxStore.getState().restoreSession("$ID"); "restored"
JS
expect_shown "$B_HOST" "after-restore"
expect_shown "$A_HOST" "after-restore"
expect_shown "$A_W1" "after-restore"
echo "## done"

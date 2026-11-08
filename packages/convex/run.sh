#!/bin/bash
# Run a Convex function against PROD with the same env dance as deploy.sh: the
# repo-root .env.local carries CONVEX_DEPLOYMENT=anonymous (the local dev
# backend) and the convex CLI picks it up even from packages/convex, so a bare
# `npx convex run` targets the wrong deployment. Usage:
#   packages/convex/run.sh syncLogPrune:markResyncAll
#   packages/convex/run.sh teamScopeSweep:run '{"dry":true}'
# Every run is a staff read through the admin key, so it is first recorded in
# the access log (accessLog:recordStaffRun): who ran it (git user and machine),
# which function, with which arguments. A regulated team's admins see the rows
# for their team's objects. The Convex dashboard is admin-key access too and
# is not recorded here.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/packages/convex"
HOLD=""
if [ -f "$ROOT/.env.local" ] && grep -q '^CONVEX_DEPLOYMENT=' "$ROOT/.env.local"; then
    HOLD="$ROOT/.env.local.runhold"
    mv "$ROOT/.env.local" "$HOLD"
fi
restore_env() { if [ -n "$HOLD" ] && [ -f "$HOLD" ]; then mv "$HOLD" "$ROOT/.env.local"; fi }
trap restore_env EXIT
FN="${1:-}"
FN_ARGS="${2:-}"
case "$FN_ARGS" in -*) FN_ARGS="" ;; esac
if [ -n "$FN" ] && [ "${FN#-}" = "$FN" ] && [ "$FN" != "accessLog:recordStaffRun" ]; then
    ACTOR="$(git -C "$ROOT" config user.email 2>/dev/null || whoami) on $(hostname -s)"
    LOG_ARGS="$(node -e 'const [a, f, j] = process.argv.slice(1); console.log(JSON.stringify({ actor: a, fn: f, ...(j ? { args_json: j } : {}) }))' "$ACTOR" "$FN" "$FN_ARGS")"
    if ! env -u CONVEX_DEPLOYMENT npx convex run accessLog:recordStaffRun "$LOG_ARGS" >/dev/null; then
        echo "run.sh: WARNING: this staff read was not recorded in the access log (accessLog:recordStaffRun failed)" >&2
    fi
fi
env -u CONVEX_DEPLOYMENT npx convex run "$@"

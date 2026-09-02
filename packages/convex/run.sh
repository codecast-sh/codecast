#!/bin/bash
# Run a Convex function against PROD with the same env dance as deploy.sh: the
# repo-root .env.local carries CONVEX_DEPLOYMENT=anonymous (the local dev
# backend) and the convex CLI picks it up even from packages/convex, so a bare
# `npx convex run` targets the wrong deployment. Usage:
#   packages/convex/run.sh syncLogPrune:markResyncAll
#   packages/convex/run.sh teamScopeSweep:run '{"dry":true}'
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
env -u CONVEX_DEPLOYMENT npx convex run "$@"

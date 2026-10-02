#!/bin/bash
# THE Convex deploy path. Convex deploys push whole-tree snapshots, so a tree
# that is behind origin/main doesn't just lack new code — it DELETES newer
# functions and routes from prod (the 2026-07-15 reparent-route outage,
# three separate clobbers in one day). This script refuses that class of
# deploy outright. Raw `npx convex deploy` is banned; see CLAUDE.md.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(git rev-parse --show-toplevel)"

if ! git fetch origin --quiet; then
    echo "REFUSING to deploy: 'git fetch origin' failed, so freshness against origin/main cannot be verified." >&2
    exit 1
fi
if ! git merge-base --is-ancestor origin/main HEAD; then
    echo "REFUSING to deploy: this tree is BEHIND origin/main." >&2
    echo "Commits it is missing:" >&2
    git log --oneline HEAD..origin/main >&2
    echo "Pull or rebase onto origin/main, then retry." >&2
    exit 1
fi

# The repo-root .env.local carries CONVEX_DEPLOYMENT=anonymous (the local dev
# pointer). The convex CLI picks it up and hijacks the deploy away from the
# self-hosted prod configured in packages/convex/.env.local — move it aside
# for the deploy and always restore it.
HOLD=""
if [ -f "$ROOT/.env.local" ] && grep -q '^CONVEX_DEPLOYMENT=' "$ROOT/.env.local"; then
    HOLD="$ROOT/.env.local.deployhold"
    mv "$ROOT/.env.local" "$HOLD"
fi
restore_env() { if [ -n "$HOLD" ] && [ -f "$HOLD" ]; then mv "$HOLD" "$ROOT/.env.local"; fi }
trap restore_env EXIT

env -u CONVEX_DEPLOYMENT npx convex deploy -y "$@"
restore_env

# Tell the Changes page the backend now runs this commit (deploy marker,
# docs/proposals/changes-page.md 7.3). A mark that cannot be recorded (cast
# missing or logged out, offline, an older server) warns and never fails the
# deploy, which has already succeeded. --dry-run prints the mark instead.
SHA="$(git rev-parse HEAD)"
MARK_DRY=""
case " $* " in *" --dry-run "*) MARK_DRY="--dry-run" ;; esac
if ! command -v cast >/dev/null 2>&1; then
    echo "warning: deploy marker skipped: cast is not on PATH" >&2
elif CAST_HTTP_TIMEOUT_MS=15000 cast ship mark --surface backend --sha "$SHA" $MARK_DRY; then
    :
else
    echo "warning: deploy marker for backend at ${SHA:0:7} not recorded; the deploy itself succeeded" >&2
fi

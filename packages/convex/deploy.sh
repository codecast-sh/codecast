#!/bin/bash
# THE Convex deploy path. Convex deploys push whole-tree snapshots, so a tree
# that is behind origin/main doesn't just lack new code — it DELETES newer
# functions and routes from prod (the 2026-07-15 reparent-route outage,
# three separate clobbers in one day). This script refuses that class of
# deploy outright. Raw `npx convex deploy` is banned; see CLAUDE.md.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(git rev-parse --show-toplevel)"

# Run as an Interactive launchd job on macOS. Started from an agent shell, a
# deploy inherits the utility QoS clamp and spends most of an hour in its
# typecheck under load, holding the lock below that every other deploy waits
# on (2026-10-02, 2026-10-04). The job reruns this script with
# CAST_LAUNCHD_LABEL set, which skips this step.
if [ "$(uname)" = "Darwin" ] && [ -z "${CAST_LAUNCHD_LABEL:-}" ] && [ -z "${DEPLOY_NO_INTERACTIVE:-}" ]; then
    exec bun "$ROOT/packages/cli/scripts/run-interactive.ts" -- "$PWD/deploy.sh" "$@"
fi

# One deploy at a time per checkout. A push ships the tree as it was bundled,
# and under load a run spends most of an hour typechecking, so two overlapping
# runs can finish out of order and the older snapshot reverts the newer one.
# A second run waits for the first, then checks freshness and bundles anew.
LOCK="$(git rev-parse --path-format=absolute --git-common-dir)/convex-deploy.lock"
while ! mkdir "$LOCK" 2>/dev/null; do
    HOLDER="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$HOLDER" ] && ! kill -0 "$HOLDER" 2>/dev/null; then
        rm -rf "$LOCK"
        continue
    fi
    echo "waiting for the deploy already running from this checkout (pid ${HOLDER:-unknown}) to finish..." >&2
    sleep 15
done
echo $$ > "$LOCK/pid"
release_lock() { rm -rf "$LOCK"; }
trap release_lock EXIT

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
trap 'restore_env; release_lock' EXIT

# Read before the push, since the push ships what is on disk at that moment:
# uncommitted edits to what the backend bundles (its functions, shared code,
# the vendored platform packages).
DIRTY="$(git -C "$ROOT" status --porcelain -- packages/convex/convex packages/shared platform/packages | wc -l | tr -d ' ')"

env -u CONVEX_DEPLOYMENT npx convex deploy -y "$@"
restore_env

# Tell the Changes page the backend now runs this commit (deploy marker,
# docs/proposals/changes-page.md 7.3). A mark that cannot be recorded (cast
# missing or logged out, offline, an older server) warns and never fails the
# deploy, which has already succeeded. --dry-run prints the mark instead.
# The marker names a commit, so a deploy from a tree with uncommitted edits
# still marks HEAD (every commit up to it is live; the edits are no commit the
# page could show) and says that it did.
SHA="$(git rev-parse HEAD)"
if [ "$DIRTY" != "0" ]; then
    echo "warning: deployed with $DIRTY uncommitted file(s) under the backend's sources; the marker records ${SHA:0:7}, which does not include them" >&2
fi
MARK_DRY=""
case " $* " in *" --dry-run "*) MARK_DRY="--dry-run" ;; esac
if ! command -v cast >/dev/null 2>&1; then
    echo "warning: deploy marker skipped: cast is not on PATH" >&2
elif CAST_HTTP_TIMEOUT_MS=15000 cast ship mark --surface backend --sha "$SHA" $MARK_DRY; then
    :
else
    echo "warning: deploy marker for backend at ${SHA:0:7} not recorded; the deploy itself succeeded" >&2
fi

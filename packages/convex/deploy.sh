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
    # A holder that died between taking the lock and writing its pid leaves a
    # lock nobody can name; past a few seconds it is no deploy's.
    AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || date +%s) ))
    if [ -z "$HOLDER" ] && [ "$AGE" -gt 30 ]; then
        rm -rf "$LOCK"
        continue
    fi
    echo "waiting for the deploy already running from this checkout (pid ${HOLDER:-unknown}) to finish..." >&2
    sleep 15
done
echo $$ > "$LOCK/pid"
release_lock() { rm -rf "$LOCK"; }
trap release_lock EXIT

# Freshness is judged against codecast-sh/codecast's main, not a fork's
# origin (see scripts/convex-base-remote.sh).
BASE_REMOTE="$("$ROOT/scripts/convex-base-remote.sh")"
if ! git fetch "$BASE_REMOTE" --quiet; then
    echo "REFUSING to deploy: 'git fetch $BASE_REMOTE' failed, so freshness against $BASE_REMOTE/main cannot be verified." >&2
    exit 1
fi
if ! git merge-base --is-ancestor "$BASE_REMOTE/main" HEAD; then
    echo "REFUSING to deploy: this tree is BEHIND $BASE_REMOTE/main." >&2
    echo "Commits it is missing:" >&2
    git log --oneline "HEAD..$BASE_REMOTE/main" >&2
    echo "Pull or rebase onto $BASE_REMOTE/main, then retry." >&2
    exit 1
fi

# An .env.local naming a CONVEX_DEPLOYMENT (the repo root's `anonymous` dev
# pointer, or a stale cloud project in this directory's) hijacks the CLI away
# from self-hosted prod: "You don't have access to the selected project"
# (2026-11-12). Move each aside for the deploy and always restore it.
HELD=()
for f in "$ROOT/.env.local" "$PWD/.env.local"; do
    if [ -f "$f" ] && grep -q '^CONVEX_DEPLOYMENT=' "$f"; then
        mv "$f" "$f.deployhold"
        HELD+=("$f")
    fi
done
restore_env() {
    for f in ${HELD[@]+"${HELD[@]}"}; do [ -f "$f.deployhold" ] && mv "$f.deployhold" "$f"; done
    HELD=()
}
trap 'restore_env; release_lock' EXIT

# Prod is self-hosted. The admin key comes from the vault when the shell does
# not carry it: the macOS Interactive re-exec above keeps no credentials, and
# this session's id survives it, so the vault's Ask first gate still applies.
export CONVEX_SELF_HOSTED_URL="${CONVEX_SELF_HOSTED_URL:-https://convex.codecast.sh}"
WITH_KEY=()
[ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ] && WITH_KEY=(cast vault run convex-admin-key --)

# Read before the push, since the push ships what is on disk at that moment:
# uncommitted edits to what the backend bundles (its functions, shared code,
# the vendored platform packages).
DIRTY="$(git -C "$ROOT" status --porcelain -- packages/convex/convex packages/shared platform/packages | wc -l | tr -d ' ')"

${WITH_KEY[@]+"${WITH_KEY[@]}"} env -u CONVEX_DEPLOYMENT npx convex deploy -y "$@"
restore_env

# Tell the Changes page the backend now runs this commit (deploy marker,
# docs/proposals/changes-page.md 7.3). A mark that cannot be recorded (cast
# missing or logged out, offline, an older server) warns and never fails the
# deploy, which has already succeeded. --dry-run prints the mark instead.
# The marker names a commit, so a deploy from a tree with uncommitted edits
# still marks HEAD (every commit up to it is live) and records how many files
# went out uncommitted with it (--dirty), which the deploy shows.
SHA="$(git rev-parse HEAD)"
if [ "$DIRTY" != "0" ]; then
    echo "warning: deployed with $DIRTY uncommitted file(s) under the backend's sources; the marker records ${SHA:0:7}, which does not include them" >&2
fi
MARK_DRY=""
case " $* " in *" --dry-run "*) MARK_DRY="--dry-run" ;; esac
MARK_EXTRA=()
[ "$DIRTY" != "0" ] && MARK_EXTRA+=(--dirty "$DIRTY")
# A deploy codecast asked for (dp-N, run by the line-deploy graph) is finished with the sha that actually went out.
[ -n "${CAST_DEPLOY_ID:-}" ] && MARK_EXTRA+=(--deploy "$CAST_DEPLOY_ID")
if [ -n "${CAST_SHIP:-}" ] && [ -z "${CAST_DEPLOY_ID:-}" ]; then
    # Under `cast ship checkout` the ship records this deploy after its push, with the sha it pushed (deploys.md DP11).
    echo "deploy marker left to the ship, which records it after the push" >&2
elif ! command -v cast >/dev/null 2>&1; then
    echo "warning: deploy marker skipped: cast is not on PATH" >&2
elif CAST_HTTP_TIMEOUT_MS=15000 cast ship mark --surface backend --sha "$SHA" ${MARK_EXTRA[@]+"${MARK_EXTRA[@]}"} $MARK_DRY; then
    :
else
    echo "warning: deploy marker for backend at ${SHA:0:7} not recorded; the deploy itself succeeded" >&2
fi

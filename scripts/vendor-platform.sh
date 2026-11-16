#!/usr/bin/env bash
# Mirror the shared @platform packages from the canonical repo into this
# tree. The copy under platform/packages is GENERATED: never edit it by hand.
# It is what ships, because Railway, the CLI release workflow and the desktop
# build all run from a fresh clone, so every dep points one level in
# (file:../../platform/packages/<name>) and never outside the checkout.
# Edit the canonical copy in ~/src/platform, then run this to refresh.
#
#   scripts/vendor-platform.sh                   # refresh the mirror
#   scripts/vendor-platform.sh vendor <name...>  # refresh only these packages (the rest stay as they are)
#   scripts/vendor-platform.sh --check           # exit 1 if the mirror has drifted
#   scripts/vendor-platform.sh --check-manifest  # exit 1 if the mirror is inconsistent (no canonical repo needed)
#   scripts/vendor-platform.sh --write-manifest  # regenerate the manifest from the mirror
#   scripts/vendor-platform.sh --list            # print the mirrored package names
#   scripts/vendor-platform.sh --list-with-tests # print the ones that have a test suite
#   scripts/vendor-platform.sh --test            # install the mirror as one workspace and run every package's tests
#
# The work is done by platform's own scripts/vendor-platform.sh, which every app
# with a mirror shares; this wrapper names codecast's mirror and consumers and
# refreshes bun's and vite's caches after a vendor run. PLATFORM_DIR picks the
# canonical repo (default ~/src/platform); point it at a worktree of one
# platform commit so a vendor run never ships another session's half-done edit.
#
# A vendor run leaves a copy of the shared script at platform/vendor-platform.sh,
# beside the manifest, because a CI runner has no ~/src/platform. This wrapper
# runs that copy, here as on the runner, so both see the same checks. For the
# canonical repo's modes (vendor, --check) the copy hands over to the canonical
# script, and --check reports a copy that has fallen behind it. Only a tree
# with no copy yet starts from the canonical repo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="$ROOT/platform"
MODE="${1:-vendor}"

SCRIPT="$MIRROR/vendor-platform.sh"
[[ -f "$SCRIPT" ]] || SCRIPT="${PLATFORM_DIR:-$HOME/src/platform}/scripts/vendor-platform.sh"
[[ -f "$SCRIPT" ]] || {
  echo "no vendor script: platform/vendor-platform.sh is not committed and $SCRIPT does not exist" >&2; exit 2; }

# A vendor run also refreshes, in place, bun's copies of the mirrored packages:
# bun materializes file: deps as COPIES under node_modules/.bun and keeps serving
# the copy after the mirror changes, which every `cast` command and eval rep
# would otherwise import. --copies names them for the shared script.
shared() {
  bash "$SCRIPT" --mirror "$MIRROR" --root "$ROOT" --consumers "$ROOT/packages/*/package.json" \
    --copies "$ROOT/node_modules/.bun/@platform+*/node_modules/@platform/*" "$@"
}

[[ "$MODE" == "vendor" ]] || { shared "$@"; exit $?; }
shared "$@"

# Then install so a package the mirror gained gets its copy, and purge every web
# optimizer cache: vite pre-bundles the old copy and serves that. .vite is the
# dev server's and .vite-smoke the smoke suite's second dev server's
# (scripts/rig/vite.smoke.config.mjs). The caches go last: a running dev server
# (plugins/depsCacheGuard.ts) restarts itself when its cache disappears, and it
# must rebuild against a finished node_modules, not one bun is still writing.
(cd "$ROOT" && bun install --silent)
rm -rf "$ROOT"/packages/web/node_modules/.vite "$ROOT"/packages/web/node_modules/.vite-smoke
echo "refreshed the @platform copies in place and cleared the vite caches"

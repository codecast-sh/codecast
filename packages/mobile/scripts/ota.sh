#!/bin/bash
# The mobile deploy target's send (.codecast/deploy.toml): an over-the-air update of
# commit $1 to every EAS channel, for every platform app.json lists. It publishes from a
# clean worktree at that commit, never from the shared checkout, whose uncommitted edits
# from other sessions are not part of the release. The app's gitignored env files are
# copied in, since the bundle reads them. The deploy run that calls this records the
# deploy (its Watch station), so this marks nothing itself.
set -euo pipefail

SHA="${1:?usage: ota.sh <sha>}"
ROOT="$(git rev-parse --show-toplevel)"
WT="$(mktemp -d "${TMPDIR:-/tmp}/codecast-ota.XXXXXX")"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
trap cleanup EXIT

git -C "$ROOT" fetch --quiet origin
git -C "$ROOT" worktree add --detach "$WT" "$SHA" >/dev/null
for f in .env .env.production; do
  if [ -f "$ROOT/packages/mobile/$f" ]; then cp "$ROOT/packages/mobile/$f" "$WT/packages/mobile/$f"; fi
done
(cd "$WT" && bun install --frozen-lockfile >/dev/null)

cd "$WT/packages/mobile"
EAS="${EAS:-npx -y eas-cli@latest}"
MESSAGE="$(git log -1 --format=%s "$SHA")"
PLATFORMS="$(node -p "(require('./app.json').expo.platforms || ['ios','android']).join(' ')")"
CHANNELS="$($EAS channel:list --json --non-interactive | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).currentPage.filter(c=>!c.isPaused).map(c=>c.name).join(" ")))')"
[ -n "$CHANNELS" ] || { echo "No EAS channels to publish to"; exit 1; }

for channel in $CHANNELS; do
  for platform in $PLATFORMS; do
    echo "Publishing ${SHA:0:10} to $channel ($platform)"
    $EAS update --channel "$channel" --platform "$platform" --message "$MESSAGE" --non-interactive
  done
done

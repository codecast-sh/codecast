#!/bin/bash
# The mobile deploy target's send (.codecast/deploy.toml): an over-the-air update of
# commit $1 to every EAS channel, for every platform app.json lists. It publishes from a
# clean worktree at that commit, never from the shared checkout, whose uncommitted edits
# from other sessions are not part of the release. The app's gitignored env files are
# copied in, since the bundle reads them. The deploy run that calls this records the
# deploy (its Watch station), so this marks nothing itself.
set -euo pipefail

SHA="${1:?usage: ota.sh <sha>}"

# It runs on whichever machine last published the deploy targets, which need not be one
# where someone ran `eas login` (dp-3801 to dp-3875 ran on a box without it). So eas signs
# in the same way everywhere: EXPO_TOKEN from the environment, else the Vault's
# expo-publish-token, put in eas's env alone; this machine's own login is the last resort.
EAS="${EAS:-npx -y eas-cli@latest}"
EXPO_SECRET=expo-publish-token
if [ -z "${EXPO_TOKEN:-}" ]; then
  # Keep why the Vault read failed (no value yet, an ask-first secret, another workspace, the network): the stop says it.
  if VAULT_WHY="$(cast vault run "$EXPO_SECRET" -- true 2>&1 >/dev/null)"; then
    EAS="cast vault run $EXPO_SECRET -- $EAS"
  elif ! $EAS whoami >/dev/null 2>&1; then
    VAULT_WHY="$(printf '%s' "$VAULT_WHY" | tr '\n' ' ' | sed 's/  */ /g; s/ $//' | cut -c1-300)"
    echo "Expo sign-in required on $(hostname -s): no EXPO_TOKEN here, the Vault's $EXPO_SECRET could not be used (${VAULT_WHY:-no reason given}), and no eas login on this machine" >&2
    exit 1
  fi
fi

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
MESSAGE="$(git log -1 --format=%s "$SHA")"
PLATFORMS="$(node -p "(require('./app.json').expo.platforms || ['ios','android']).join(' ')")"
# Read whole before parsing, so a failing eas stops the send on its own error.
LISTED="$($EAS channel:list --json --non-interactive)"
CHANNELS="$(printf '%s' "$LISTED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).currentPage.filter(c=>!c.isPaused).map(c=>c.name).join(" ")))')"
[ -n "$CHANNELS" ] || { echo "No EAS channels to publish to"; exit 1; }

for channel in $CHANNELS; do
  for platform in $PLATFORMS; do
    echo "Publishing ${SHA:0:10} to $channel ($platform)"
    $EAS update --channel "$channel" --platform "$platform" --message "$MESSAGE" --non-interactive
  done
done

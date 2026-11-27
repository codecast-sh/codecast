#!/bin/bash
# The desktop deploy target's send (.codecast/deploy.toml): cut a macOS desktop
# release in CI (.github/workflows/cut-desktop-release.yml), so any machine can
# send it, not only the one holding the Developer ID identity. It builds main's
# head, which must carry this deploy's commit. If the published release already
# carries it, the deploy is recorded live and nothing is cut; while another cut
# is in flight it waits for it. The release goes live when
# dl.codecast.sh/desktop/release.json names its commit; the deploy run waits for that.
set -euo pipefail
REPO=codecast-sh/codecast
WORKFLOW=cut-desktop-release.yml
WAIT_SECONDS=${CUT_WAIT_SECONDS:-5400}
POLL_SECONDS=${CUT_POLL_SECONDS:-60}
deadline=$(( $(date +%s) + WAIT_SECONDS ))

while :; do
  busy=$(gh run list -R "$REPO" --workflow "$WORKFLOW" -L 5 --json status,databaseId -q '.[] | select(.status != "completed") | "\(.databaseId) "')
  [[ -z "$busy" ]] && break
  if (( $(date +%s) >= deadline )); then
    echo "Still waiting for the desktop release in flight (runs $busy) after ${WAIT_SECONDS}s"
    exit 1
  fi
  echo "Waiting for the desktop release in flight (runs $busy)"
  sleep "$POLL_SECONDS"
done

git fetch --quiet origin main
live=$(curl -fsSL --retry 3 -H 'Cache-Control: no-cache' https://dl.codecast.sh/desktop/release.json || true)
live_sha=$(jq -r '.sourceCommit // ""' <<<"$live" 2>/dev/null || true)
live_version=$(jq -r '.version // ""' <<<"$live" 2>/dev/null || true)
if [[ -n "${CAST_DEPLOY_SHA:-}" && -n "${CAST_DEPLOY_ID:-}" && -n "$live_sha" ]] &&
  git merge-base --is-ancestor "$CAST_DEPLOY_SHA" "$live_sha" 2>/dev/null; then
  echo "Desktop $live_version (${live_sha:0:10}) already carries ${CAST_DEPLOY_SHA:0:10}: no new release cut"
  cast ship mark --surface desktop --sha "$live_sha" --version "$live_version" --deploy "$CAST_DEPLOY_ID"
  exit 0
fi

source=$(git rev-parse origin/main)
if [[ -n "${CAST_DEPLOY_SHA:-}" ]] && ! git merge-base --is-ancestor "$CAST_DEPLOY_SHA" "$source"; then
  echo "origin/main (${source:0:10}) does not carry ${CAST_DEPLOY_SHA:0:10}"
  exit 1
fi
echo "Cutting desktop from ${source:0:10}, main's head"
gh workflow run "$WORKFLOW" -R "$REPO" -f source_commit="$source"
sleep "${CUT_DISPATCH_SETTLE_SECONDS:-5}"
gh run list -R "$REPO" --workflow "$WORKFLOW" -L 1 --json url -q '.[0].url'

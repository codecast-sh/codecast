#!/bin/bash
# The cli deploy target's send (.codecast/deploy.toml): cut a CLI release in CI
# (CLAUDE.md "CLI releases"). Two releases at once race on the version bump, so while
# a cut or finalize run is in flight it waits for that release to finish (ct-102056).
# If the release that finished already holds this deploy's commit, the deploy is
# recorded live at it and nothing is cut; otherwise it cuts at main's head. The
# release goes live when dl.codecast.sh/latest.json names its commit; the deploy run
# waits for that.
set -euo pipefail
REPO=codecast-sh/codecast
WAIT_SECONDS=${CUT_WAIT_SECONDS:-4800}
POLL_SECONDS=${CUT_POLL_SECONDS:-60}
deadline=$(( $(date +%s) + WAIT_SECONDS ))
waited=false
while :; do
  busy=""
  for wf in cut-cli-release.yml finalize-cli-release.yml; do
    busy+="$(gh run list -R "$REPO" --workflow "$wf" -L 5 --json status,databaseId -q '.[] | select(.status != "completed") | "\(.databaseId) "')"
  done
  [ -n "$busy" ] || break
  if (( $(date +%s) >= deadline )); then
    echo "A CLI release was still in flight after ${WAIT_SECONDS}s (runs $busy)"
    exit 1
  fi
  echo "Waiting for the CLI release in flight (runs $busy)"
  waited=true
  sleep "$POLL_SECONDS"
done
if [[ "$waited" == true && -n "${CAST_DEPLOY_SHA:-}" && -n "${CAST_DEPLOY_ID:-}" ]]; then
  latest=$(curl -fsSL --retry 3 -H 'Cache-Control: no-cache' https://dl.codecast.sh/latest.json || true)
  live_sha=$(jq -r '.sourceCommit // ""' <<<"$latest" 2>/dev/null || true)
  live_version=$(jq -r '.version // ""' <<<"$latest" 2>/dev/null || true)
  git fetch --quiet origin main || true
  if [[ -n "$live_sha" && -n "$live_version" ]] && git merge-base --is-ancestor "$CAST_DEPLOY_SHA" "$live_sha" 2>/dev/null; then
    echo "CLI $live_version (${live_sha:0:10}) already carries ${CAST_DEPLOY_SHA:0:10}: no new release cut"
    cast ship mark --surface cli --sha "$live_sha" --version "$live_version" --deploy "$CAST_DEPLOY_ID"
    exit 0
  fi
fi
gh workflow run cut-cli-release.yml -R "$REPO"
sleep "${CUT_DISPATCH_SETTLE_SECONDS:-5}"
gh run list -R "$REPO" --workflow cut-cli-release.yml -L 1 --json url -q '.[0].url'

#!/bin/bash
# The cli deploy target's send (.codecast/deploy.toml): cut a CLI release in CI
# (CLAUDE.md "CLI releases"). Two releases at once race on the version bump, so while
# a cut or finalize run is in flight it waits for that release to finish (ct-102056).
# If the public release already holds this deploy's commit, the deploy is recorded
# live at it and nothing is cut. Otherwise it cuts the newest main commit that CI
# already passed, carries this deploy's commit and comes after the last version
# bump: on a busy main a newer push cancels a pending CI run, so main's head may
# never get the verdict finalize waits for. With no such commit yet it waits too.
# The release goes live when dl.codecast.sh/latest.json names its commit; the
# deploy run waits for that.
set -euo pipefail
REPO=codecast-sh/codecast
WAIT_SECONDS=${CUT_WAIT_SECONDS:-4800}
POLL_SECONDS=${CUT_POLL_SECONDS:-60}
deadline=$(( $(date +%s) + WAIT_SECONDS ))

already_live() {
  [[ -n "${CAST_DEPLOY_SHA:-}" && -n "${CAST_DEPLOY_ID:-}" ]] || return 1
  local latest
  latest=$(curl -fsSL --retry 3 -H 'Cache-Control: no-cache' https://dl.codecast.sh/latest.json || true)
  live_sha=$(jq -r '.sourceCommit // ""' <<<"$latest" 2>/dev/null || true)
  live_version=$(jq -r '.version // ""' <<<"$latest" 2>/dev/null || true)
  [[ -n "$live_sha" && -n "$live_version" ]] && git merge-base --is-ancestor "$CAST_DEPLOY_SHA" "$live_sha" 2>/dev/null
}

green_source() {
  local version green c
  version=$(git show origin/main:packages/cli/package.json | jq -r '.version')
  green=$(gh run list -R "$REPO" --workflow ci.yml --branch main --event push --status success -L 100 --json headSha -q '.[].headSha')
  while read -r c; do
    grep -qx "$c" <<<"$green" || continue
    [[ "$(git show "$c:packages/cli/package.json" | jq -r '.version')" == "$version" ]] || return 1
    if [[ -n "${CAST_DEPLOY_SHA:-}" ]] && ! git merge-base --is-ancestor "$CAST_DEPLOY_SHA" "$c"; then return 1; fi
    echo "$c"
    return 0
  done < <(git rev-list --first-parent -n 300 origin/main)
  return 1
}

while :; do
  busy=""
  for wf in cut-cli-release.yml finalize-cli-release.yml; do
    busy+="$(gh run list -R "$REPO" --workflow "$wf" -L 5 --json status,databaseId -q '.[] | select(.status != "completed") | "\(.databaseId) "')"
  done
  if [[ -z "$busy" ]]; then
    git fetch --quiet origin main
    if already_live; then
      echo "CLI $live_version (${live_sha:0:10}) already carries ${CAST_DEPLOY_SHA:0:10}: no new release cut"
      cast ship mark --surface cli --sha "$live_sha" --version "$live_version" --deploy "$CAST_DEPLOY_ID"
      exit 0
    fi
    if source=$(green_source); then break; fi
    why="main's CI to pass on a commit after the last release${CAST_DEPLOY_SHA:+ that includes ${CAST_DEPLOY_SHA:0:7}}"
  else
    why="the CLI release in flight (runs $busy)"
  fi
  if (( $(date +%s) >= deadline )); then
    echo "Still waiting for $why after ${WAIT_SECONDS}s"
    exit 1
  fi
  echo "Waiting for $why"
  sleep "$POLL_SECONDS"
done
echo "Cutting ${source:0:10}, the newest main commit with a green CI verdict"
gh workflow run cut-cli-release.yml -R "$REPO" -f source_commit="$source"
sleep "${CUT_DISPATCH_SETTLE_SECONDS:-5}"
gh run list -R "$REPO" --workflow cut-cli-release.yml -L 1 --json url -q '.[0].url'

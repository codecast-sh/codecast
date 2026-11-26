#!/bin/bash
# The cli deploy target's send (.codecast/deploy.toml): cut a CLI release in CI
# (CLAUDE.md "CLI releases"). Two releases at once race on the version bump, so while
# a cut or finalize run is in flight it waits for that release to finish, then cuts at
# main's head, which carries this deploy's commit (ct-102056). The release goes live
# when dl.codecast.sh/latest.json names its commit; the deploy run waits for that.
set -euo pipefail
REPO=codecast-sh/codecast
WAIT_SECONDS=${CUT_WAIT_SECONDS:-4800}
deadline=$(( $(date +%s) + WAIT_SECONDS ))
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
  sleep 60
done
gh workflow run cut-cli-release.yml -R "$REPO"
sleep 5
gh run list -R "$REPO" --workflow cut-cli-release.yml -L 1 --json url -q '.[0].url'

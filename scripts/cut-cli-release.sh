#!/bin/bash
# The cli deploy target's send (.codecast/deploy.toml): cut a CLI release in CI
# (CLAUDE.md "CLI releases"). It refuses while a cut or finalize run is already in
# flight, since two releases at once race on the version bump. The release goes live
# when dl.codecast.sh/latest.json names its commit; the deploy run waits for that.
set -euo pipefail
REPO=codecast-sh/codecast
for wf in cut-cli-release.yml finalize-cli-release.yml; do
  busy="$(gh run list -R "$REPO" --workflow "$wf" -L 5 --json status,url -q '.[] | select(.status != "completed") | .url')"
  [ -z "$busy" ] || { echo "A $wf run is already in flight: $busy"; exit 1; }
done
gh workflow run cut-cli-release.yml -R "$REPO"
sleep 5
gh run list -R "$REPO" --workflow cut-cli-release.yml -L 1 --json url -q '.[0].url'

#!/bin/bash
set -e

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

PREVIEW_ONLY=false
FORCE_CLI=false
SKIP_CLI_CHECKS=false
FORCE_DESKTOP=false
for arg in "$@"; do
  case "$arg" in
    --preview) PREVIEW_ONLY=true ;;
    --force) FORCE_CLI=true ;;
    --desktop) FORCE_DESKTOP=true ;;
    # Forward the CLI release's pre-deploy typecheck+test override (see
    # packages/cli/scripts/deploy.sh --skip-checks). Discouraged: only when the
    # only failures are known-unrelated/flaky and verified out-of-band.
    --skip-checks) SKIP_CLI_CHECKS=true ;;
  esac
done
SKIP_CHECKS_FLAG=""
$SKIP_CLI_CHECKS && SKIP_CHECKS_FLAG="--skip-checks"

echo "=== Codecast Full Deployment ==="
if $PREVIEW_ONLY; then
  echo "    (preview OTA only -- skipping production OTA)"
fi
echo ""

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo "Error: Uncommitted changes detected. Commit or stash first."
  exit 1
fi

# 0. Pre-flight: Mirror Railway build process locally
echo "0. Pre-flight: Running Railway build locally..."
echo "   This mirrors exactly what Railway will do"
echo ""

# Install dependencies (same as Railway)
echo "   Installing dependencies..."
# --frozen-lockfile mirrors Railway exactly: a package.json/bun.lock mismatch fails
# the web deploy AFTER convex is already live (2026-08-26). A plain install
# silently rewrites the lock and hides that.
bun install --frozen-lockfile

# Build convex (same as Railway)
echo "   Building Convex..."
cd packages/convex
bun run build 2>/dev/null || true
cd ../..

# Clean build web (same as Railway)
echo "   Building web (clean)..."
cd packages/web
rm -rf .next
set -o pipefail
if ! bun run build 2>&1 | tee /tmp/web-build.log; then
  echo ""
  echo "   ✗ Web build failed! Fix errors before deploying."
  echo ""
  echo "Build output:"
  tail -30 /tmp/web-build.log
  exit 1
fi
cd ../..
echo ""
echo "   ✓ Railway build simulation passed"
echo ""

# One release, in the order that keeps every part working with every other:
#   1. Convex, before anything that calls new functions ships
#   2. push: Railway builds web from main
#   3. CLI, cut in CI; with --force, the fleet floor, then wait for Macs to run it
#   4. mobile OTA
#   5. desktop, published without a floor; the floor goes up only once the
#      fleet runs a CLI that installs the app safely. A desktop floor ahead of
#      the CLI made old daemons do the install and left apps "damaged"
#      (2026-09-24).
#   6. wait until Railway serves the final commit
# Flags: --force forces the new CLI on every daemon; --desktop releases the
# desktop app even with no change under packages/electron; --preview sends
# the mobile OTA to the preview branch; --skip-checks is accepted for
# compatibility (CI runs the checks).

# 1. Convex. THE deploy path (CLAUDE.md): it refuses a tree behind origin/main,
# whose whole-tree snapshot would delete newer prod functions.
echo "1. Deploying Convex functions..."
./packages/convex/deploy.sh
echo "   ✓ Convex deployed"
echo ""

# 2. Push: web follows main on Railway.
echo "2. Pushing main..."
git push origin main
echo ""

# 3. CLI. The published build names its source commit; a change under the
# CLI's inputs since then needs a release. The finalize job's version bump
# touches only package.json, so that file is left out of the comparison.
echo "3. Checking CLI for changes..."
PUBLISHED_SRC=$(curl -fsS https://dl.codecast.sh/latest.json | sed -n 's/.*"sourceCommit"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')
CLI_NEEDS_RELEASE=true
if [[ -n "$PUBLISHED_SRC" ]] && git cat-file -e "$PUBLISHED_SRC^{commit}" 2>/dev/null \
  && git diff --quiet "$PUBLISHED_SRC" HEAD -- packages/cli ':!packages/cli/package.json' packages/shared platform; then
  CLI_NEEDS_RELEASE=false
fi
CLI_VERSION=""
if $CLI_NEEDS_RELEASE; then
  HEAD_SHA=$(git rev-parse HEAD)
  echo "   Cutting the CLI release in CI from ${HEAD_SHA:0:9}..."
  gh workflow run cut-cli-release.yml -R codecast-sh/codecast
  # The finalize job publishes latest.json with this commit as its source.
  for _ in $(seq 1 120); do
    sleep 30
    LATEST=$(curl -fsS https://dl.codecast.sh/latest.json || true)
    if echo "$LATEST" | grep -q "\"sourceCommit\": *\"$HEAD_SHA\""; then
      CLI_VERSION=$(echo "$LATEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      break
    fi
    FAILED=$(gh run list -R codecast-sh/codecast --workflow cut-cli-release.yml -L 1 --json conclusion -q '.[0].conclusion')
    [[ "$FAILED" == "failure" ]] && { echo "   ✗ CLI release failed in CI: gh run list --workflow cut-cli-release.yml"; exit 1; }
  done
  [[ -z "$CLI_VERSION" ]] && { echo "   ✗ CLI release did not publish within an hour"; exit 1; }
  echo "   ✓ CLI v$CLI_VERSION published"
  git pull --rebase --autostash origin main  # the finalize job's version bump
  if $FORCE_CLI; then
    cast force-update "$CLI_VERSION"
  fi
else
  echo "   CLI unchanged since the published build - skipping"
fi
echo ""

# Wait until most Macs seen in the last 30 minutes run at least $1, for up to
# $2 minutes. True when they do.
await_fleet() {
  local version="$1" minutes="$2" out total current
  for _ in $(seq 1 "$minutes"); do
    out=$(./packages/convex/run.sh devices:fleetAdoption "{\"version\":\"$version\"}" 2>/dev/null | tr -d "\n")
    total=$(echo "$out" | sed -n 's/.*"total": *\([0-9]*\).*/\1/p')
    current=$(echo "$out" | sed -n 's/.*"current": *\([0-9]*\).*/\1/p')
    if [[ -n "$total" && "$total" -gt 0 && $((current * 10)) -ge $((total * 9)) ]]; then
      echo "   ✓ $current of $total Macs run CLI v$version"
      return 0
    fi
    echo "   ${current:-?} of ${total:-?} Macs run CLI v$version; waiting..."
    sleep 60
  done
  echo "   Behind: $out"
  return 1
}

# 4. Mobile OTA update
echo "4. Pushing mobile OTA update..."
LAST_MOBILE_UPDATE=$(git log -1 --format=%H -- packages/mobile/)
LAST_MOBILE_OTA_MARKER=".last-mobile-ota"

if [[ -f "$LAST_MOBILE_OTA_MARKER" ]] && [[ "$(cat "$LAST_MOBILE_OTA_MARKER")" == "$LAST_MOBILE_UPDATE" ]]; then
  echo "   No mobile changes since last OTA - skipping"
else
  COMMIT_MSG=$(git log -1 --format=%s -- packages/mobile/)
  cd packages/mobile
  # Watchman wedges silently on macOS when its launchd agent is loaded-but-not-started
  # (e.g. after a `watchman shutdown-server`), making Metro/eas hang forever on
  # "Waiting for Watchman watch-project". Kickstart the agent first so the OTA bundles
  # instead of hanging. See memory: watchman_wedged_stale_metro_bundles.
  if [[ "$(uname)" == "Darwin" ]] && command -v watchman >/dev/null 2>&1; then
    if ! timeout 8 watchman version >/dev/null 2>&1; then
      echo "   watchman wedged — kickstarting com.github.facebook.watchman"
      launchctl kickstart -k "gui/$(id -u)/com.github.facebook.watchman" 2>/dev/null || true
      timeout 8 watchman version >/dev/null 2>&1 && echo "   watchman recovered" || echo "   WARNING: watchman still wedged; OTA may hang"
    fi
  fi
  if $PREVIEW_ONLY; then
    echo "   Pushing to preview branch..."
    eas update --branch preview --message "$COMMIT_MSG" --non-interactive
    echo "   ✓ OTA pushed to preview"
  else
    echo "   Pushing to production branch..."
    eas update --branch production --message "$COMMIT_MSG" --non-interactive
    echo "   ✓ OTA pushed to production"
  fi
  cd ../..
  echo "$LAST_MOBILE_UPDATE" > "$LAST_MOBILE_OTA_MARKER"
fi
echo ""


# 5. Desktop. A change under packages/electron since the last version bump
# needs a release. release.sh builds, notarizes and publishes; the floor waits
# for the fleet's CLI (see the top of this file).
echo "5. Checking desktop app for changes..."
DESKTOP_BASE=$(git log -1 --format=%H -G'"version":' -- packages/electron/package.json)
if $FORCE_DESKTOP || ! git diff --quiet "$DESKTOP_BASE" HEAD -- packages/electron ':!packages/electron/package.json'; then
  ./packages/electron/scripts/release.sh patch --no-git --no-floor
  DESKTOP_VERSION=$(node -p "require('./packages/electron/package.json').version")
  git add packages/electron/package.json packages/web/server/index.ts
  git commit -m "chore(electron): release desktop $DESKTOP_VERSION"
  git push origin main
  FLOOR_CLI="${CLI_VERSION:-$(curl -fsS https://dl.codecast.sh/latest.json | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)}"
  if await_fleet "$FLOOR_CLI" 30; then
    cast desktop-force-update "$DESKTOP_VERSION"
    echo "   ✓ Desktop v$DESKTOP_VERSION published; fleet floor set"
  else
    echo "   ! Desktop v$DESKTOP_VERSION published, floor NOT set: too few Macs run CLI v$FLOOR_CLI."
    echo "     Set it once they do: cast desktop-force-update $DESKTOP_VERSION"
  fi
else
  echo "   Desktop unchanged since v$(node -p "require('./packages/electron/package.json').version") - skipping"
fi
echo ""

# 6. Railway serves main once its deploy of the final commit succeeds.
echo "6. Waiting for Railway to serve $(git rev-parse --short HEAD)..."
FINAL_SHA=$(git rev-parse HEAD)
for _ in $(seq 1 40); do
  STATE=$(gh api "repos/codecast-sh/codecast/deployments?sha=$FINAL_SHA" --jq '.[0].id' 2>/dev/null \
    | xargs -I{} gh api "repos/codecast-sh/codecast/deployments/{}/statuses" --jq '.[0].state' 2>/dev/null)
  [[ "$STATE" == "success" ]] && { echo "   ✓ Web live"; break; }
  [[ "$STATE" == "failure" || "$STATE" == "error" ]] && { echo "   ✗ Railway deploy $STATE"; exit 1; }
  sleep 30
done
echo ""
echo "=== Deployment Complete ==="

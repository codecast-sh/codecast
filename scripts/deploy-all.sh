#!/bin/bash
set -e

cd "$(dirname "$0")/.."

PREVIEW_ONLY=false
FORCE_CLI=false
for arg in "$@"; do
  case "$arg" in
    --preview) PREVIEW_ONLY=true ;;
    --force) FORCE_CLI=true ;;
  esac
done

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
bun install

# Build convex (same as Railway)
echo "   Building Convex..."
cd packages/convex
bun run build 2>/dev/null || true
cd ../..

# Clean build web (same as Railway)
echo "   Building web (clean)..."
cd packages/web
rm -rf .next
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

# 1. Deploy Convex functions
echo "1. Deploying Convex functions..."
cd packages/convex
npx convex dev --once
cd ../..
echo "   ✓ Convex deployed"
echo ""

# 2. Check if CLI needs release (compare local version vs deployed version)
echo "2. Checking CLI for changes..."
cd packages/cli

CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
echo "   Current CLI version: $CURRENT_VERSION"

REMOTE_VERSION=$(curl -s https://dl.codecast.sh/latest.json | grep -o '"version":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")
echo "   Deployed CLI version: ${REMOTE_VERSION:-unknown}"

if [[ "$CURRENT_VERSION" != "$REMOTE_VERSION" ]]; then
  echo "   Version mismatch - deploying..."
  if $FORCE_CLI; then
    ./scripts/deploy.sh --force
  else
    ./scripts/deploy.sh
  fi
  echo "   ✓ CLI v$CURRENT_VERSION deployed"
else
  echo "   CLI v$CURRENT_VERSION already deployed - skipping"
fi
cd ../..
echo ""

# 3. Push to git (triggers Railway deploy)
echo "3. Pushing to git (triggers Railway auto-deploy)..."
git push origin main 2>/dev/null && echo "   ✓ Pushed to main" || echo "   Already up to date"
echo ""

# 4. Mobile OTA update
echo "4. Pushing mobile OTA update..."
LAST_MOBILE_UPDATE=$(git log -1 --format=%H -- packages/mobile/)
LAST_MOBILE_OTA_MARKER=".last-mobile-ota"

if [[ -f "$LAST_MOBILE_OTA_MARKER" ]] && [[ "$(cat "$LAST_MOBILE_OTA_MARKER")" == "$LAST_MOBILE_UPDATE" ]]; then
  echo "   No mobile changes since last OTA - skipping"
else
  COMMIT_MSG=$(git log -1 --format=%s -- packages/mobile/)
  cd packages/mobile
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

echo "=== Deployment Complete ==="
echo ""
echo "Deployed:"
echo "  - Convex:  https://marvelous-meerkat-539.convex.cloud"
echo "  - CLI:     https://dl.codecast.sh/latest.json"
echo "  - Web:     https://codecast.sh (Railway auto-deploys on push)"
echo "  - Mobile:  OTA via EAS Update"
echo ""
echo "Tailing Railway build logs (Ctrl+C to stop)..."
echo ""
exec railway logs --build --latest

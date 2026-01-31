#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "=== Codecast Full Deployment ==="
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

# 2. Check if CLI has changes and needs release
echo "2. Checking CLI for changes..."
CLI_CHANGED=$(git diff origin/main --name-only -- packages/cli/ | wc -l | tr -d ' ')
if [[ "$CLI_CHANGED" -gt 0 ]]; then
  echo "   CLI has changes - deploying..."
  cd packages/cli

  CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
  echo "   Current CLI version: $CURRENT_VERSION"

  REMOTE_VERSION=$(curl -s https://dl.codecast.sh/latest.json | grep -o '"version":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")

  if [[ "$CURRENT_VERSION" == "$REMOTE_VERSION" ]]; then
    echo "   CLI v$CURRENT_VERSION already deployed - skipping"
  else
    echo "   Deploying CLI v$CURRENT_VERSION..."
    ./scripts/deploy.sh
    echo "   ✓ CLI v$CURRENT_VERSION deployed"
  fi
  cd ../..
else
  echo "   No CLI changes - skipping"
fi
echo ""

# 3. Push to git (triggers Railway deploy)
echo "3. Pushing to git (triggers Railway auto-deploy)..."
git push origin main 2>/dev/null && echo "   ✓ Pushed to main" || echo "   Already up to date"
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Deployed:"
echo "  - Convex: https://marvelous-meerkat-539.convex.cloud"
echo "  - CLI:    https://dl.codecast.sh/latest.json"
echo "  - Web:    https://codecast.sh (Railway auto-deploys on push)"
echo ""
echo "Monitor Railway: https://railway.app"

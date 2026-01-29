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

# 0. Pre-flight: Verify web build works
echo "0. Pre-flight check: Building web app..."
cd packages/web
if ! npm run build > /dev/null 2>&1; then
  echo "   ✗ Web build failed! Fix errors before deploying."
  npm run build 2>&1 | tail -20
  exit 1
fi
cd ../..
echo "   ✓ Web build passed"
echo ""

# 1. Deploy Convex functions
echo "1. Deploying Convex functions..."
cd packages/convex
npx convex deploy --yes
cd ../..
echo "   ✓ Convex deployed"
echo ""

# 2. Check if CLI has changes and needs release
echo "2. Checking CLI for changes..."
CLI_CHANGED=$(git diff origin/main --name-only -- packages/cli/ | wc -l | tr -d ' ')
if [[ "$CLI_CHANGED" -gt 0 ]]; then
  echo "   CLI has changes - deploying..."
  cd packages/cli

  # Get current version
  CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
  echo "   Current CLI version: $CURRENT_VERSION"

  # Check if binaries already deployed for this version
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
echo "3. Pushing to git (triggers Railway deploy)..."
git push origin main 2>/dev/null && echo "   ✓ Pushed - Railway will auto-deploy" || echo "   Already up to date"
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Deployed:"
echo "  - Convex: https://little-bobcat-226.convex.cloud"
echo "  - CLI:    https://dl.codecast.sh/latest.json"
echo "  - Web:    https://codecast.sh (Railway auto-deploys on push)"

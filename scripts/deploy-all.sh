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

# 0. Pre-flight: Clean build to catch errors
echo "0. Pre-flight check: Clean build of web app..."
cd packages/web
rm -rf .next
if ! bun run build 2>&1 | tee /tmp/web-build.log | tail -5; then
  echo "   ✗ Web build failed! Fix errors before deploying."
  echo ""
  echo "Build output:"
  cat /tmp/web-build.log | tail -30
  exit 1
fi

# Verify key routes are in build output
if ! grep -q "/admin/daemon-logs" /tmp/web-build.log; then
  echo "   ✗ Build missing /admin/daemon-logs route!"
  exit 1
fi
cd ../..
echo "   ✓ Web build passed (all routes present)"
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
echo "3. Pushing to git (triggers Railway deploy)..."
git push origin main 2>/dev/null && echo "   ✓ Pushed" || echo "   Already up to date"
echo ""

# 4. Wait for Railway to auto-deploy from git push
echo "4. Waiting for Railway deployment..."
echo "   Railway auto-deploys on push to main"
echo "   Waiting 120s for build and deploy..."

# Poll for deployment completion
for i in {1..12}; do
  sleep 10
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://codecast.sh/admin/daemon-logs?_=$(date +%s)")
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "   ✓ Deployment verified! /admin/daemon-logs is live (HTTP $HTTP_CODE)"
    break
  fi
  echo "   ... still deploying ($((i*10))s) - HTTP $HTTP_CODE"
done

if [[ "$HTTP_CODE" != "200" ]]; then
  echo ""
  echo "   ⚠ /admin/daemon-logs returned HTTP $HTTP_CODE after 120s"
  echo "   Railway deployment may have failed or is still in progress"
  echo "   Check Railway dashboard: https://railway.app"
  echo ""
  echo "   To debug Railway builds:"
  echo "   1. Run: railway link (select codecast project)"
  echo "   2. Run: railway logs --build"
fi
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Deployed:"
echo "  - Convex: https://little-bobcat-226.convex.cloud"
echo "  - CLI:    https://dl.codecast.sh/latest.json"
echo "  - Web:    https://codecast.sh"

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

# 4. Trigger Railway deploy and tail logs
echo "4. Deploying to Railway..."
if command -v railway &> /dev/null; then
  # Get the latest deployment
  echo "   Triggering Railway deployment..."

  # Use railway up to deploy and stream logs
  railway up --detach 2>&1 | head -5 || true

  echo "   Waiting for Railway build to start..."
  sleep 5

  # Tail the deployment logs
  echo ""
  echo "   === Railway Build Logs ==="
  timeout 180 railway logs --build 2>&1 | while IFS= read -r line; do
    echo "   $line"
    # Check for success/failure indicators
    if echo "$line" | grep -q "Deploy.*successful\|Deployment live"; then
      echo ""
      echo "   ✓ Railway deployment successful!"
      break
    fi
    if echo "$line" | grep -q "Deploy.*failed\|Build failed\|error"; then
      echo ""
      echo "   ✗ Railway deployment may have failed - check logs"
    fi
  done || echo "   (Log streaming timed out - check Railway dashboard)"
  echo "   ==========================="
  echo ""

  # Verify the deployment
  echo "5. Verifying deployment..."
  sleep 10
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://codecast.sh/admin/daemon-logs?_=$(date +%s)")
  if [[ "$HTTP_CODE" == "200" ]]; then
    echo "   ✓ /admin/daemon-logs is live (HTTP $HTTP_CODE)"
  else
    echo "   ⚠ /admin/daemon-logs returned HTTP $HTTP_CODE (may still be deploying)"
    echo "   Check: https://codecast.sh/admin/daemon-logs"
  fi
else
  echo "   Railway CLI not installed - skipping log streaming"
  echo "   Install with: brew install railway"
  echo "   Monitor at: https://railway.app"
fi
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Deployed:"
echo "  - Convex: https://little-bobcat-226.convex.cloud"
echo "  - CLI:    https://dl.codecast.sh/latest.json"
echo "  - Web:    https://codecast.sh"

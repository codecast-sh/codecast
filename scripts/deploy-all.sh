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
npx convex deploy
cd ../..
echo "   ✓ Convex deployed"
echo ""

# 2. Check if CLI needs release
echo "2. Checking CLI for changes..."
cd packages/cli

CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
echo "   Current CLI version: $CURRENT_VERSION"

REMOTE_VERSION=$(curl -s https://dl.codecast.sh/latest.json | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' 2>/dev/null || echo "")
echo "   Deployed CLI version: ${REMOTE_VERSION:-unknown}"

LAST_CLI_MARKER="../../.last-cli-deploy"
LAST_CLI_HASH=$(git log -1 --format=%H -- .)
PREV_CLI_HASH=""
[[ -f "$LAST_CLI_MARKER" ]] && PREV_CLI_HASH=$(cat "$LAST_CLI_MARKER")

CLI_NEEDS_DEPLOY=false
if [[ -n "$REMOTE_VERSION" && "$CURRENT_VERSION" != "$REMOTE_VERSION" ]]; then
  echo "   Version mismatch ($CURRENT_VERSION local vs $REMOTE_VERSION remote) - deploying..."
  CLI_NEEDS_DEPLOY=true
elif [[ "$LAST_CLI_HASH" != "$PREV_CLI_HASH" ]]; then
  echo "   Code changed since last deploy but version not bumped."
  # Auto-bump patch version
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  NEW_PATCH=$((PATCH + 1))
  NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"
  echo "   Auto-bumping version: $CURRENT_VERSION -> $NEW_VERSION"
  sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
  sed -i '' "s/const VERSION = \"$CURRENT_VERSION\"/const VERSION = \"$NEW_VERSION\"/" src/update.ts
  CURRENT_VERSION="$NEW_VERSION"
  git add package.json src/update.ts
  git commit -m "chore(cli): bump version to $NEW_VERSION"
  CLI_NEEDS_DEPLOY=true
fi

if $CLI_NEEDS_DEPLOY; then
  if $FORCE_CLI; then
    ./scripts/deploy.sh --force
  else
    ./scripts/deploy.sh
  fi
  echo "$LAST_CLI_HASH" > "$LAST_CLI_MARKER"
  echo "   ✓ CLI v$CURRENT_VERSION deployed"
else
  echo "   CLI v$CURRENT_VERSION already deployed, no code changes - skipping"
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

# 5. Desktop app (Electron) - auto-bump, build, sign, and deploy when changed
echo "5. Checking desktop app for changes..."
LAST_DESKTOP_UPDATE=$(git log -1 --format=%H -- packages/electron/)
LAST_DESKTOP_MARKER=".last-desktop-deploy"

if [[ -f "$LAST_DESKTOP_MARKER" ]] && [[ "$(cat "$LAST_DESKTOP_MARKER")" == "$LAST_DESKTOP_UPDATE" ]]; then
  echo "   No desktop changes since last deploy - skipping"
else
  cd packages/electron
  CURRENT_DESKTOP_VERSION=$(node -p "require('./package.json').version")
  echo "   Desktop changes detected (current: v$CURRENT_DESKTOP_VERSION)"

  # Auto-bump patch version so electron-updater detects the new release
  IFS='.' read -r D_MAJOR D_MINOR D_PATCH <<< "$CURRENT_DESKTOP_VERSION"
  NEW_D_PATCH=$((D_PATCH + 1))
  NEW_DESKTOP_VERSION="$D_MAJOR.$D_MINOR.$NEW_D_PATCH"
  echo "   Auto-bumping version: $CURRENT_DESKTOP_VERSION -> $NEW_DESKTOP_VERSION"
  sed -i '' "s/\"version\": \"$CURRENT_DESKTOP_VERSION\"/\"version\": \"$NEW_DESKTOP_VERSION\"/" package.json
  git add package.json
  git commit -m "chore(electron): bump version to $NEW_DESKTOP_VERSION"
  git push origin main 2>/dev/null || true

  echo "   Building signed desktop app..."
  # /bin must be first in PATH -- /usr/local/bin/ln doesn't support -s on this system,
  # which breaks DMG creation (electron-builder uses `ln -s /Applications`)
  PATH="/bin:/usr/bin:$PATH" NOTARIZE_KEYCHAIN_PROFILE=codecast npm run build

  ELECTRON_VERSION=$(node -p "require('./package.json').version")
  DMG_FILE=$(find dist -name "*.dmg" -maxdepth 1 -newer dist/mac-arm64 | head -1)
  if [ -z "$DMG_FILE" ]; then
    echo "   ERROR: No DMG found in dist/"
    cd ../..
    exit 1
  fi
  DMG_NAME="Codecast-${ELECTRON_VERSION}-arm64.dmg"

  echo "   Uploading to R2..."
  npx wrangler r2 object put "codecast/$DMG_NAME" --file "$DMG_FILE" --remote

  ZIP_FILE=$(find dist -name "*-mac.zip" -maxdepth 1 -newer dist/mac-arm64 | head -1)
  YML_FILE="dist/latest-mac.yml"
  if [ -n "$ZIP_FILE" ] && [ -f "$YML_FILE" ]; then
    ZIP_NAME=$(basename "$ZIP_FILE")
    npx wrangler r2 object put "codecast/desktop/$ZIP_NAME" --file "$ZIP_FILE" --remote
    npx wrangler r2 object put "codecast/desktop/latest-mac.yml" --file "$YML_FILE" --remote
    echo "   ✓ Auto-update artifacts uploaded (desktop/$ZIP_NAME + latest-mac.yml)"
  else
    echo "   WARNING: Auto-update artifacts not found, uploading manual zip fallback"
    ditto -c -k --keepParent dist/mac-arm64/Codecast.app /tmp/Codecast-mac-arm64.zip
    npx wrangler r2 object put codecast/Codecast-mac-arm64.zip --file /tmp/Codecast-mac-arm64.zip --remote
  fi
  cd ../..
  echo "$LAST_DESKTOP_UPDATE" > "$LAST_DESKTOP_MARKER"

  ROUTE_FILE="packages/web/app/download/mac/route.ts"
  if [ -f "$ROUTE_FILE" ]; then
    sed -i '' "s|Codecast-.*-arm64.dmg|Codecast-${ELECTRON_VERSION}-arm64.dmg|" "$ROUTE_FILE"
    sed -i '' "s/const VERSION = \".*\"/const VERSION = \"$ELECTRON_VERSION\"/" "$ROUTE_FILE"
  fi
  echo "   ✓ Desktop app v$ELECTRON_VERSION deployed to dl.codecast.sh/$DMG_NAME"
fi
echo ""

echo "=== Deployment Complete ==="
echo ""
CONVEX_DISPLAY_URL="${CONVEX_SELF_HOSTED_URL:-self-hosted}"
echo "Deployed:"
echo "  - Convex:  $CONVEX_DISPLAY_URL"
echo "  - CLI:     https://dl.codecast.sh/latest.json"
echo "  - Web:     https://codecast.sh (Railway auto-deploys on push)"
echo "  - Mobile:  OTA via EAS Update"
echo "  - Desktop: dl.codecast.sh/Codecast-<version>-arm64.dmg (if deployed)"
echo ""
echo "Tailing Railway build logs (Ctrl+C to stop)..."
echo ""
exec railway logs --build --latest

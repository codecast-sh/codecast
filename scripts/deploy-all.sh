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
if $FORCE_CLI; then
  echo "   --force passed - deploying CLI unconditionally..."
  CLI_NEEDS_DEPLOY=true
elif [[ -n "$REMOTE_VERSION" && "$CURRENT_VERSION" != "$REMOTE_VERSION" ]]; then
  echo "   Version mismatch ($CURRENT_VERSION local vs $REMOTE_VERSION remote) - deploying..."
  CLI_NEEDS_DEPLOY=true
elif [[ "$LAST_CLI_HASH" != "$PREV_CLI_HASH" ]]; then
  echo "   Code changed since last deploy - deploying..."
  CLI_NEEDS_DEPLOY=true
fi

if $CLI_NEEDS_DEPLOY; then
  if $FORCE_CLI; then
    ./scripts/deploy.sh --force
  else
    ./scripts/deploy.sh
  fi
  CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
  # Re-read hash AFTER deploy.sh (which may have committed a version bump)
  echo "$(git log -1 --format=%H -- .)" > "$LAST_CLI_MARKER"
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
  # The DMG step has two failure modes that both surface as a misleading
  # "Command failed: which python" (dmg-builder runs vendored dmgbuild/core.py,
  # and when that throws it falls back to `which python`, which macOS no longer
  # ships, masking the real error):
  #   1) `which python3` resolves to /usr/bin/python3 (the Xcode stub) or
  #      Homebrew's default python3 (3.14 here has a broken libexpat link) --
  #      neither can run dmgbuild. Fix: shim a python3 that CAN import dmgbuild's
  #      deps first on PATH so `which python3` finds it.
  #   2) a stale /Volumes/Codecast mount left by a previous failed build makes
  #      core.py's mount step fail. Fix: detach any leftover Codecast volume.
  for _v in /Volumes/Codecast*; do [ -d "$_v" ] && hdiutil detach "$_v" -force 2>/dev/null; done
  PY_SHIM=""
  for _py in python3.12 python3.13 python3.11; do
    _p=$(command -v "$_py" 2>/dev/null) || continue
    "$_p" -c "import xml.parsers.expat, plistlib" 2>/dev/null || continue
    PY_SHIM=$(mktemp -d)
    ln -sf "$_p" "$PY_SHIM/python3"
    ln -sf "$_p" "$PY_SHIM/python"
    echo "   dmg-builder python: $_p (via shim $PY_SHIM)"
    break
  done
  [ -n "$PY_SHIM" ] || echo "   WARNING: no working python3 found for dmg-builder; DMG step may fail"
  # /bin must be first in PATH -- /usr/local/bin/ln doesn't support -s on this system,
  # which breaks DMG creation (electron-builder uses `ln -s /Applications`).
  # The python shim goes before /usr/bin so it wins over the Xcode stub. Invoke
  # electron-builder directly (same `electron-builder -m` the build script runs)
  # to keep this PATH exactly as set.
  PATH="/bin:${PY_SHIM:+$PY_SHIM:}/usr/bin:$PATH" NOTARIZE_KEYCHAIN_PROFILE=codecast ./node_modules/.bin/electron-builder -m

  ELECTRON_VERSION=$(node -p "require('./package.json').version")
  DMG_FILE=$(find dist -name "*.dmg" -maxdepth 1 -newer dist/mac-arm64 | head -1)
  if [ -z "$DMG_FILE" ]; then
    echo "   ERROR: No DMG found in dist/"
    cd ../..
    exit 1
  fi
  DMG_NAME="Codecast-${ELECTRON_VERSION}-arm64.dmg"

  echo "   Uploading to R2..."
  # Versioned filenames never change content, so cache them hard at the Cloudflare edge.
  IMMUTABLE_CC="public, max-age=31536000, immutable"

  npx wrangler r2 object put "codecast/$DMG_NAME" --file "$DMG_FILE" --remote \
    --content-type "application/x-apple-diskimage" --cache-control "$IMMUTABLE_CC"

  ZIP_FILE=$(find dist -name "*-mac.zip" -maxdepth 1 -newer dist/mac-arm64 | head -1)
  YML_FILE="dist/latest-mac.yml"
  if [ -n "$ZIP_FILE" ] && [ -f "$YML_FILE" ]; then
    ZIP_NAME=$(basename "$ZIP_FILE")
    npx wrangler r2 object put "codecast/desktop/$ZIP_NAME" --file "$ZIP_FILE" --remote \
      --content-type "application/zip" --cache-control "$IMMUTABLE_CC"

    # The zip blockmap is what lets electron-updater do differential (delta) downloads --
    # without it every update pulls the full zip instead of just the changed blocks.
    ZIP_BLOCKMAP="$ZIP_FILE.blockmap"
    if [ -f "$ZIP_BLOCKMAP" ]; then
      npx wrangler r2 object put "codecast/desktop/$(basename "$ZIP_BLOCKMAP")" --file "$ZIP_BLOCKMAP" --remote \
        --content-type "application/octet-stream" --cache-control "$IMMUTABLE_CC"
    else
      echo "   WARNING: $ZIP_BLOCKMAP not found -- delta updates disabled for this release"
    fi

    # The manifest changes every release and is polled to detect updates, so it must never
    # be edge-cached or clients would keep seeing the old version.
    npx wrangler r2 object put "codecast/desktop/latest-mac.yml" --file "$YML_FILE" --remote \
      --content-type "text/yaml" --cache-control "no-cache"
    echo "   ✓ Auto-update artifacts uploaded (desktop/$ZIP_NAME + blockmap + latest-mac.yml)"
  else
    echo "   WARNING: Auto-update artifacts not found, uploading manual zip fallback"
    ditto -c -k --keepParent dist/mac-arm64/Codecast.app /tmp/Codecast-mac-arm64.zip
    npx wrangler r2 object put codecast/Codecast-mac-arm64.zip --file /tmp/Codecast-mac-arm64.zip --remote \
      --content-type "application/zip" --cache-control "$IMMUTABLE_CC"
  fi
  cd ../..
  echo "$LAST_DESKTOP_UPDATE" > "$LAST_DESKTOP_MARKER"

  SERVER_FILE="packages/web/server/index.ts"
  if [ -f "$SERVER_FILE" ]; then
    sed -i '' "s/const LATEST_DESKTOP_VERSION = \".*\"/const LATEST_DESKTOP_VERSION = \"$ELECTRON_VERSION\"/" "$SERVER_FILE"
    sed -i '' "s|const MAC_DMG_URL = \"https://dl.codecast.sh/Codecast-.*-arm64.dmg\"|const MAC_DMG_URL = \"https://dl.codecast.sh/Codecast-${ELECTRON_VERSION}-arm64.dmg\"|" "$SERVER_FILE"
    sed -i '' "s/const MAC_DMG_VERSION = \".*\"/const MAC_DMG_VERSION = \"$ELECTRON_VERSION\"/" "$SERVER_FILE"
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
exec railway logs --build --lines 50

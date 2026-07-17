#!/bin/bash
set -e

cd "$(dirname "$0")/.."
REPO_ROOT="$(cd ../.. && pwd)"

# Load R2 credentials from CLI's .env.deploy
ENV_FILE="$REPO_ROOT/packages/cli/.env.deploy"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found"
  echo "Create it with AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_ENDPOINT"
  exit 1
fi
export $(cat "$ENV_FILE" | xargs)
export AWS_DEFAULT_REGION=auto

: "${AWS_ACCESS_KEY_ID:?Missing AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Missing AWS_SECRET_ACCESS_KEY}"
: "${R2_ENDPOINT:?Missing R2_ENDPOINT}"

R2_BUCKET="codecast"
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

OLD_VERSION=$(jq -r '.version' package.json)
# Bump via jq (not `npm version`): npm walks up to the bun workspace root and
# chokes on `workspace:*` deps it can't parse. Mirrors packages/cli/deploy.sh.
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

echo "=== Releasing Codecast Desktop v$NEW_VERSION (was v$OLD_VERSION) ==="
echo ""

# Build (includes code signing + notarization via afterSign hook)
echo "[1/4] Building and notarizing..."
npm run build 2>&1

echo ""
echo "[2/4] Uploading to R2..."
ARTIFACTS=(
  "dist/Codecast-${NEW_VERSION}-arm64-mac.zip"
  "dist/Codecast-${NEW_VERSION}-arm64.dmg"
  "dist/Codecast-${NEW_VERSION}-arm64-mac.zip.blockmap"
  "dist/Codecast-${NEW_VERSION}-arm64.dmg.blockmap"
  "dist/latest-mac.yml"
)
# Versioned binaries are immutable, but latest-mac.yml is polled for new releases.
IMMUTABLE_CC="public, max-age=31536000, immutable"
for f in "${ARTIFACTS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "  ERROR: $f not found"
    exit 1
  fi
  case "$f" in
    *.dmg) CT="application/x-apple-diskimage"; CC="$IMMUTABLE_CC" ;;
    *.zip) CT="application/zip"; CC="$IMMUTABLE_CC" ;;
    *.blockmap) CT="application/octet-stream"; CC="$IMMUTABLE_CC" ;;
    *.yml) CT="text/yaml"; CC="no-cache" ;;
    *) CT="application/octet-stream"; CC="$IMMUTABLE_CC" ;;
  esac
  echo "  $(basename $f)"
  aws s3 cp "$f" "s3://$R2_BUCKET/desktop/$(basename $f)" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "$CT" \
    --cache-control "$CC" \
    --quiet
done

echo ""
echo "[3/4] Verifying upload..."
REMOTE=$(curl -sf https://dl.codecast.sh/desktop/latest-mac.yml | head -1)
if [[ "$REMOTE" != "version: $NEW_VERSION" ]]; then
  echo "  ERROR: Remote latest-mac.yml does not match v$NEW_VERSION"
  echo "  Got: $REMOTE"
  exit 1
fi
echo "  Verified: $REMOTE"

# Prewarm the CDN so the fleet's forced update doesn't hit a cold cache: the
# first fetch after upload streams from the R2 origin (measured minutes for
# 94MB from a distant edge during the v1.1.84 rollout); one GET through the
# public domain caches it at this edge and, with Tiered Cache enabled on the
# zone, at the upper tier every other edge fills from. Best-effort — a warm
# failure must never fail the release.
echo "  Prewarming CDN..."
for f in "Codecast-${NEW_VERSION}-arm64-mac.zip" "Codecast-${NEW_VERSION}-arm64.dmg"; do
  curl -so /dev/null --max-time 300 -w "    $f: %{speed_download} B/s\n" "https://dl.codecast.sh/desktop/$f" || echo "    $f: prewarm failed (non-fatal)"
done

# NOTE: releases do NOT force the fleet to update — clients are prompted in-app
# (Update now / Later) and otherwise update on next quit. To push a specific
# version to everyone (quit+relaunch even while open), run it deliberately:
#   cast desktop-force-update <version>

echo ""
echo "[4/4] Updating web download URL and committing..."
WEB_SERVER="$REPO_ROOT/packages/web/server/index.ts"
sed -i '' "s|Codecast-${OLD_VERSION}-arm64.dmg|Codecast-${NEW_VERSION}-arm64.dmg|g" "$WEB_SERVER"
sed -i '' "s|MAC_DMG_VERSION = \"${OLD_VERSION}\"|MAC_DMG_VERSION = \"${NEW_VERSION}\"|g" "$WEB_SERVER"

cd "$REPO_ROOT"
git add packages/electron/package.json packages/web/server/index.ts
git commit -m "chore(electron): bump desktop to v${NEW_VERSION}"
git push origin main

echo ""
echo "=== Desktop v$NEW_VERSION released ==="
echo "  https://dl.codecast.sh/desktop/latest-mac.yml"
echo "  https://dl.codecast.sh/desktop/Codecast-${NEW_VERSION}-arm64.dmg"

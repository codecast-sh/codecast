#!/bin/bash
# Desktop release: bump, build + notarize, verify the asar, upload to R2, verify
# the published feed, warm the CDN. Parameterized by environment; every step
# that taught codecast a lesson keeps its comment.
#
# Required env (or a .env file passed as RELEASE_ENV_FILE):
#   PRODUCT_NAME      Codecast            (bundle and artifact prefix)
#   R2_BUCKET         codecast            (bucket name)
#   R2_PREFIX         desktop             (key prefix inside the bucket)
#   PUBLIC_BASE_URL   https://dl.codecast.sh/desktop
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_ENDPOINT   (UPLOADER=aws, the default)
#   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or NOTARIZE_KEYCHAIN_PROFILE,
#   or APPLE_ID + APPLE_PASSWORD [+ APPLE_TEAM_ID]
# Optional:
#   CHANNEL           latest              (feed file <channel>-mac.yml)
#   ARCH              arm64
#   BUILD_CMD         "npx electron-builder -m --config electron-builder.config.js"
#   UPLOADER          aws (default) or wrangler: wrangler writes through its own
#                     Cloudflare login, so no R2 S3 keys are needed. With several
#                     accounts on the login, set CLOUDFLARE_ACCOUNT_ID.
#   AFTER_RELEASE     a command run at the end (codecast rewrites its download URL and commits)
set -e

cd "$(dirname "$0")"
if [ -n "${RELEASE_ENV_FILE:-}" ]; then
  [ -f "$RELEASE_ENV_FILE" ] || { echo "Error: $RELEASE_ENV_FILE not found"; exit 1; }
  export $(grep -v '^#' "$RELEASE_ENV_FILE" | xargs)
fi
export AWS_DEFAULT_REGION=auto

: "${PRODUCT_NAME:?Missing PRODUCT_NAME}"
: "${R2_BUCKET:?Missing R2_BUCKET}"
: "${R2_PREFIX:?Missing R2_PREFIX}"
: "${PUBLIC_BASE_URL:?Missing PUBLIC_BASE_URL}"
UPLOADER="${UPLOADER:-aws}"
if [ "$UPLOADER" = aws ]; then
  : "${AWS_ACCESS_KEY_ID:?Missing AWS_ACCESS_KEY_ID}"
  : "${AWS_SECRET_ACCESS_KEY:?Missing AWS_SECRET_ACCESS_KEY}"
  : "${R2_ENDPOINT:?Missing R2_ENDPOINT}"
elif [ "$UPLOADER" != wrangler ]; then
  echo "Error: UPLOADER must be aws or wrangler"; exit 1
fi

# put <file> <key> <content-type> <cache-control> [content-disposition]
put() {
  if [ "$UPLOADER" = wrangler ]; then
    ${WRANGLER:-bunx wrangler} r2 object put "$R2_BUCKET/$R2_PREFIX/$2" --file "$1" --remote \
      --content-type "$3" --cache-control "$4" ${5:+--content-disposition "$5"} >/dev/null
  else
    aws s3 cp "$1" "s3://$R2_BUCKET/$R2_PREFIX/$2" --endpoint-url "$R2_ENDPOINT" \
      --content-type "$3" --cache-control "$4" ${5:+--content-disposition "$5"} --quiet
  fi
}
CHANNEL="${CHANNEL:-latest}"
ARCH="${ARCH:-arm64}"
BUILD_CMD="${BUILD_CMD:-npx electron-builder -m --config electron-builder.config.js}"
FEED="${CHANNEL}-mac.yml"

BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

OLD_VERSION=$(jq -r '.version' package.json)
# Bump via jq (not `npm version`): npm walks up to the bun workspace root and
# chokes on `workspace:*` deps it can't parse.
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

echo "=== Releasing $PRODUCT_NAME Desktop v$NEW_VERSION (was v$OLD_VERSION) ==="
echo ""

# Build (includes code signing + notarization via the afterSign hook)
echo "[1/4] Building and notarizing..."
$BUILD_CMD 2>&1

# A local require missing from build.files ships an app that dies at boot
# (codecast v1.1.85: main.js required ./updaterNet but the asar didn't contain it).
echo ""
echo "[1.5/4] Verifying asar contains every local require and the shell package..."
ASAR="dist/mac-${ARCH}/${PRODUCT_NAME}.app/Contents/Resources/app.asar"
ASAR_LIST=$(npx asar list "$ASAR")
for src in main.js; do
  for mod in $(grep -oE 'require\("\./[^"]+"\)' "$src" | sed -E 's|require\("\./([^"]+)"\)|\1|'); do
    if ! echo "$ASAR_LIST" | grep -qE "^/${mod}(\.js)?$"; then
      echo "  ERROR: $src requires ./$mod but it is not in the asar — add it to files"
      exit 1
    fi
    echo "  $src -> ./$mod ok"
  done
done
for f in /node_modules/@platform/desktop/src/main.js /node_modules/@platform/desktop/src/preload.js /node_modules/@platform/desktop/src/updaterNet.js; do
  if ! echo "$ASAR_LIST" | grep -qx "$f"; then
    echo "  ERROR: $f is not in the asar — keep node_modules/@platform/desktop/src/** in files"
    exit 1
  fi
done
echo "  @platform/desktop ok"

echo ""
echo "[2/4] Uploading to R2..."
ARTIFACTS=(
  "dist/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}-mac.zip"
  "dist/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}.dmg"
  "dist/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}-mac.zip.blockmap"
  "dist/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}.dmg.blockmap"
  "dist/${FEED}"
)
# Versioned binaries are immutable, but the feed is polled for new releases.
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
  put "$f" "$(basename $f)" "$CT" "$CC"
done
# A stable name for download buttons (<product>-<arch>.dmg), so a website links
# one URL that always serves the newest build. Short cache: it moves each release.
LATEST_DMG="${PRODUCT_NAME}-${ARCH}.dmg"
echo "  $LATEST_DMG (latest alias)"
put "dist/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}.dmg" "$LATEST_DMG" "application/x-apple-diskimage" "public, max-age=300" \
  "attachment; filename=\"${PRODUCT_NAME}.dmg\""

echo ""
echo "[3/4] Verifying upload..."
REMOTE=$(curl -sf "$PUBLIC_BASE_URL/$FEED" | head -1)
if [[ "$REMOTE" != "version: $NEW_VERSION" ]]; then
  echo "  ERROR: Remote $FEED does not match v$NEW_VERSION"
  echo "  Got: $REMOTE"
  exit 1
fi
echo "  Verified: $REMOTE"

# Prewarm the CDN so the fleet's update doesn't hit a cold cache: the first
# fetch after upload streams from the R2 origin (measured minutes for 94MB from
# a distant edge during codecast's v1.1.84 rollout); one GET through the public
# domain caches it at this edge and, with Tiered Cache enabled on the zone, at
# the upper tier every other edge fills from. Best-effort — a warm failure must
# never fail the release.
echo "  Prewarming CDN..."
for f in "${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}-mac.zip" "${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}.dmg"; do
  curl -so /dev/null --max-time 300 -w "    $f: %{speed_download} B/s\n" "$PUBLIC_BASE_URL/$f" || echo "    $f: prewarm failed (non-fatal)"
done

# NOTE: releases do NOT force the fleet to update — clients are prompted in-app
# (Update now / Later) and otherwise update on next quit. To push a specific
# version to everyone, raise the minimum version the app's `update.minVersion`
# source returns (codecast: `cast desktop-force-update <version>`).

echo ""
echo "[4/4] After release..."
if [ -n "${AFTER_RELEASE:-}" ]; then
  OLD_VERSION="$OLD_VERSION" NEW_VERSION="$NEW_VERSION" bash -c "$AFTER_RELEASE"
fi

echo ""
echo "=== $PRODUCT_NAME Desktop v$NEW_VERSION released ==="
echo "  $PUBLIC_BASE_URL/$FEED"
echo "  $PUBLIC_BASE_URL/${PRODUCT_NAME}-${NEW_VERSION}-${ARCH}.dmg"
echo "  $PUBLIC_BASE_URL/${PRODUCT_NAME}-${ARCH}.dmg (always the latest)"

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
# --no-git: build, upload and set the floor, but leave the version bump and
# the web download pointer uncommitted. For a shared checkout where the web
# server file carries someone else's in-flight edits, or a worktree whose
# push must be one controlled step: the caller commits and pushes by hand.
BUMP_TYPE="patch"
NO_GIT=0
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP_TYPE="$arg" ;;
    --no-git) NO_GIT=1 ;;
    *) echo "Usage: ./scripts/release.sh [patch|minor|major] [--no-git]"; exit 1 ;;
  esac
done

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
source "$REPO_ROOT/scripts/dmg-build-env.sh"
PATH="$DMG_BUILD_PATH" npm run build 2>&1

# A local require missing from build.files ships an app that dies at boot
# (v1.1.85: main.js required ./updaterNet but the asar didn't contain it).
echo ""
echo "[1.5/4] Verifying asar contains every local require..."
ASAR="dist/mac-arm64/Codecast.app/Contents/Resources/app.asar"
ASAR_LIST=$(npx asar list "$ASAR")
# Every packaged module, not just the entry points: osPermissions.js is what
# requires the native addon. A .node keeps its extension and must also sit
# on disk beside the asar (asarUnpack), or dlopen fails inside the archive.
for src in $(jq -r '.build.files[] | select(endswith(".js"))' package.json); do
  for mod in $(grep -oE 'require\("\./[^"]+"\)' "$src" | sed -E 's|require\("\./([^"]+)"\)|\1|'); do
    case "$mod" in *.js|*.node) f="/$mod" ;; *) f="/$mod.js" ;; esac
    if ! echo "$ASAR_LIST" | grep -qx "$f"; then
      echo "  ERROR: $src requires ./$mod but $f is not in the asar — add it to build.files"
      exit 1
    fi
    if [[ "$f" == *.node ]] && [ ! -f "${ASAR}.unpacked$f" ]; then
      echo "  ERROR: $f is inside the asar but not unpacked — add it to build.asarUnpack"
      exit 1
    fi
    echo "  $src -> .$f ok"
  done
done

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

# Every release is the fleet's floor, as CLI releases are: daemons apply it
# within five minutes, quitting and relaunching an open app (the same lever
# as `cast desktop-force-update`). Non-fatal — the artifacts are already
# live, and a missed floor is set by hand.
echo "  Setting the fleet floor to $NEW_VERSION..."
cast desktop-force-update "$NEW_VERSION" || echo "    floor not set (non-fatal): run cast desktop-force-update $NEW_VERSION"

echo ""
echo "[4/4] Updating web download URL and committing..."
WEB_SERVER="$REPO_ROOT/packages/web/server/index.ts"
sed -i '' "s|Codecast-${OLD_VERSION}-arm64.dmg|Codecast-${NEW_VERSION}-arm64.dmg|g" "$WEB_SERVER"
sed -i '' "s|MAC_DMG_VERSION = \"${OLD_VERSION}\"|MAC_DMG_VERSION = \"${NEW_VERSION}\"|g" "$WEB_SERVER"

cd "$REPO_ROOT"
if [ "$NO_GIT" = "1" ]; then
  echo "  --no-git: commit packages/electron/package.json and the MAC_DMG lines of packages/web/server/index.ts, then push"
else
  git add packages/electron/package.json packages/web/server/index.ts
  git commit -m "chore(electron): bump desktop to v${NEW_VERSION}"
  git push origin main
fi

echo ""
echo "=== Desktop v$NEW_VERSION released ==="
echo "  https://dl.codecast.sh/desktop/latest-mac.yml"
echo "  https://dl.codecast.sh/desktop/Codecast-${NEW_VERSION}-arm64.dmg"

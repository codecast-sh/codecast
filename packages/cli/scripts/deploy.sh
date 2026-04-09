#!/bin/bash
set -e

cd "$(dirname "$0")/.."

FORCE_UPDATE=false
BUMP_TYPE="patch"

while [[ $# -gt 0 ]]; do
  case $1 in
    --force)
      FORCE_UPDATE=true
      shift
      ;;
    patch|minor|major)
      BUMP_TYPE="$1"
      shift
      ;;
    *)
      echo "Usage: ./scripts/deploy.sh [patch|minor|major] [--force]"
      echo "  patch|minor|major  Version bump type (default: patch)"
      echo "  --force            Force all remote clients to update immediately"
      exit 1
      ;;
  esac
done

if [ -f .env.deploy ]; then
  export $(cat .env.deploy | xargs)
fi

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID or create .env.deploy}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY or create .env.deploy}"

R2_BUCKET="codecast"
: "${R2_ENDPOINT:?Set R2_ENDPOINT (e.g. https://<account-id>.r2.cloudflarestorage.com)}"
export AWS_DEFAULT_REGION="auto"
BINARIES_DIR="../web/binaries"

# Version bump (package.json is the single source of truth — update.ts imports it)
OLD_VERSION=$(jq -r '.version' package.json)
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
echo "Version: $OLD_VERSION -> $NEW_VERSION"

VERSION="$NEW_VERSION"

echo "Deploying codecast CLI v$VERSION"

# Build binaries
echo ""
echo "Building binaries..."
./scripts/build-binaries.sh

# Upload binaries
echo ""
echo "Uploading binaries to R2..."
for file in "$BINARIES_DIR"/*; do
  filename=$(basename "$file")
  echo "  $filename"
  aws s3 cp "$file" "s3://$R2_BUCKET/$filename" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/octet-stream" \
    --quiet
done

# Generate checksums and latest.json
echo ""
echo "Generating latest.json..."
LATEST_JSON=$(cat <<EOF
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "binaries": {
    "darwin-arm64": {
      "url": "https://dl.codecast.sh/codecast-darwin-arm64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-darwin-arm64" | cut -d' ' -f1)"
    },
    "darwin-x64": {
      "url": "https://dl.codecast.sh/codecast-darwin-x64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-darwin-x64" | cut -d' ' -f1)"
    },
    "linux-arm64": {
      "url": "https://dl.codecast.sh/codecast-linux-arm64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-linux-arm64" | cut -d' ' -f1)"
    },
    "linux-x64": {
      "url": "https://dl.codecast.sh/codecast-linux-x64",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-linux-x64" | cut -d' ' -f1)"
    },
    "windows-x64": {
      "url": "https://dl.codecast.sh/codecast-windows-x64.exe",
      "sha256": "$(shasum -a 256 "$BINARIES_DIR/codecast-windows-x64.exe" | cut -d' ' -f1)"
    }
  }
}
EOF
)

echo "$LATEST_JSON" > /tmp/latest.json
aws s3 cp /tmp/latest.json "s3://$R2_BUCKET/latest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json" \
  --quiet

echo ""
echo "Deployed v$VERSION"
echo "  https://dl.codecast.sh/latest.json"

# Commit version bump
git add package.json
git commit -m "chore(cli): bump version to $VERSION"
git push

if [[ "$FORCE_UPDATE" == "true" ]]; then
  echo ""
  echo "Setting minimum CLI version to force remote updates..."
  codecast force-update "$VERSION"
else
  echo ""
  echo "To force all remote clients to update:"
  echo "  codecast force-update $VERSION"
fi

#!/bin/bash
set -e

cd "$(dirname "$0")/.."

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"

R2_BUCKET="codecast"
R2_ENDPOINT="https://518bafbd08199d43fe9080a12a7ac1b7.r2.cloudflarestorage.com"
BINARIES_DIR="../web/public/binaries"

VERSION=$(jq -r '.version' package.json)
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

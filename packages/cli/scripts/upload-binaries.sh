#!/bin/bash
set -e

cd "$(dirname "$0")/.."

BINARIES_DIR="../web/public/binaries"
R2_BUCKET="codecast"
R2_ENDPOINT="https://518bafbd08199d43fe9080a12a7ac1b7.r2.cloudflarestorage.com"

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"

if [ ! -d "$BINARIES_DIR" ]; then
  echo "Error: Binaries directory not found at $BINARIES_DIR"
  echo "Run ./scripts/build-binaries.sh first"
  exit 1
fi

echo "Uploading binaries to R2..."

for file in "$BINARIES_DIR"/*; do
  filename=$(basename "$file")
  echo "Uploading $filename..."
  aws s3 cp "$file" "s3://$R2_BUCKET/$filename" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/octet-stream"
done

echo ""
echo "All binaries uploaded to R2"
echo "Available at https://dl.codecast.sh/<binary-name>"

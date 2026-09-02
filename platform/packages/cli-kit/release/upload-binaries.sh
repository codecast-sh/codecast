#!/bin/bash
# Upload the five binaries to R2, write latest.json (sha256 per platform), write
# the npm shim's checksums.json, and warm the CDN. Ported from the upload half of
# codecast's packages/cli/scripts/deploy.sh. Run from the CLI package directory
# after build-binaries.sh.
#
# Usage: upload-binaries.sh <version> [--no-prewarm]
#
# Iterate the exact artifact list, never glob the output dir: it accumulates
# strays across runs (a local alias symlink once shipped as a duplicate object).
# Warm the CDN BEFORE the fleet is forced to update: a cold edge streams from
# the origin, and one GET per artifact fills the tier every other edge reads.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/release.env" ] && set -a && . "$HERE/release.env" && set +a

VERSION="${1:?Usage: upload-binaries.sh <version>}"
PREWARM=true; [[ "${2:-}" == "--no-prewarm" ]] && PREWARM=false

: "${BINARY_NAME:?Set BINARY_NAME}"
: "${RELEASE_BASE_URL:?Set RELEASE_BASE_URL}"
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${R2_ENDPOINT:?Set R2_ENDPOINT}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="auto"
OUTPUT_DIR="${OUTPUT_DIR:-../web/binaries}"
NPM_DIR="${NPM_DIR:-npm}"
MANIFEST_NAME="${MANIFEST_NAME:-latest.json}"   # latest-beta.json for a beta channel

KEYS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-x64)
asset() { if [[ "$1" == windows-* ]]; then echo "$BINARY_NAME-$1.exe"; else echo "$BINARY_NAME-$1"; fi; }
sha() { shasum -a 256 "$OUTPUT_DIR/$(asset "$1")" | cut -d' ' -f1; }

echo "Uploading binaries to R2..."
for key in "${KEYS[@]}"; do
  f="$(asset "$key")"
  echo "  $f"
  aws s3 cp "$OUTPUT_DIR/$f" "s3://$R2_BUCKET/$f" --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/octet-stream" --quiet
done

echo "Writing $MANIFEST_NAME..."
MANIFEST=$(jq -n --arg v "$VERSION" --arg released "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg base "$RELEASE_BASE_URL" \
  --arg k0 "${KEYS[0]}" --arg a0 "$(asset "${KEYS[0]}")" --arg s0 "$(sha "${KEYS[0]}")" \
  --arg k1 "${KEYS[1]}" --arg a1 "$(asset "${KEYS[1]}")" --arg s1 "$(sha "${KEYS[1]}")" \
  --arg k2 "${KEYS[2]}" --arg a2 "$(asset "${KEYS[2]}")" --arg s2 "$(sha "${KEYS[2]}")" \
  --arg k3 "${KEYS[3]}" --arg a3 "$(asset "${KEYS[3]}")" --arg s3 "$(sha "${KEYS[3]}")" \
  --arg k4 "${KEYS[4]}" --arg a4 "$(asset "${KEYS[4]}")" --arg s4 "$(sha "${KEYS[4]}")" \
  '{version:$v, released:$released, binaries:{
     ($k0):{url:($base+"/"+$a0),sha256:$s0}, ($k1):{url:($base+"/"+$a1),sha256:$s1},
     ($k2):{url:($base+"/"+$a2),sha256:$s2}, ($k3):{url:($base+"/"+$a3),sha256:$s3},
     ($k4):{url:($base+"/"+$a4),sha256:$s4}}}')
echo "$MANIFEST" > /tmp/$MANIFEST_NAME
aws s3 cp /tmp/$MANIFEST_NAME "s3://$R2_BUCKET/$MANIFEST_NAME" --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json" --cache-control "no-cache, no-store, must-revalidate" --quiet
echo "  $RELEASE_BASE_URL/$MANIFEST_NAME"

if [ -d "$NPM_DIR" ]; then
  echo "Syncing $NPM_DIR/package.json and checksums.json..."
  jq --arg v "$VERSION" '.version = $v' "$NPM_DIR/package.json" > "$NPM_DIR/package.json.tmp" && mv "$NPM_DIR/package.json.tmp" "$NPM_DIR/package.json"
  echo "$MANIFEST" | jq '.binaries | with_entries(.value = .value.sha256)' > "$NPM_DIR/checksums.json"
fi

if $PREWARM; then
  echo "Prewarming CDN..."
  for key in "${KEYS[@]}"; do
    f="$(asset "$key")"
    curl -so /dev/null --max-time 300 -w "  $f: %{speed_download} B/s\n" "$RELEASE_BASE_URL/$f" || echo "  $f: prewarm failed (non-fatal)"
  done
fi
echo "Uploaded v$VERSION"

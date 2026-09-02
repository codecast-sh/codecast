#!/bin/bash
# Compile one bun entrypoint into five single file binaries and sign the macOS
# ones with a stable Developer ID identity. Ported from codecast's
# packages/cli/scripts/build-binaries.sh. Run from the CLI package directory.
#
# Why sign: bun's --compile output is ad hoc signed, so its identity is the
# content hash and every release looks like a new app to macOS. TCC grants and
# background task items are keyed to that identity, so ad hoc binaries prompt
# the user again after every self update. A stable identifier plus a Developer
# ID cert makes grants survive. No hardened runtime: bun needs JIT.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/release.env" ] && set -a && . "$HERE/release.env" && set +a

: "${BINARY_NAME:?Set BINARY_NAME}"
ENTRYPOINT="${ENTRYPOINT:-src/index.ts}"
OUTPUT_DIR="${OUTPUT_DIR:-../web/binaries}"
SIGN_IDENTIFIER="${SIGN_IDENTIFIER:-com.example.${BINARY_NAME}.cli}"
mkdir -p "$OUTPUT_DIR"

# Optional guard hook: refuse to build when stale build outputs shadow sources.
if [ -n "${PREBUILD_GUARD:-}" ]; then bash "$PREBUILD_GUARD"; fi

targets=(darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-x64)
echo "Building $BINARY_NAME binaries..."
for target in "${targets[@]}"; do
  if [[ "$target" == "windows-x64" ]]; then
    outfile="$OUTPUT_DIR/$BINARY_NAME-$target.exe"
  else
    outfile="$OUTPUT_DIR/$BINARY_NAME-$target"
  fi
  echo "  $target"
  bun build "$ENTRYPOINT" --compile --target="bun-$target" --minify --sourcemap --outfile="$outfile"
done

if [[ "$(uname)" == "Darwin" ]]; then
  if [[ "${SKIP_SIGN:-}" == "1" ]]; then
    echo "WARNING: skipping macOS code signing (SKIP_SIGN=1); ad hoc binaries reset TCC grants on every update"
  elif [[ -z "${SIGN_IDENTITY:-}" ]]; then
    echo "ABORT: SIGN_IDENTITY is not set. Set it, or SKIP_SIGN=1 to ship ad hoc binaries." >&2
    exit 1
  elif ! security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
    echo "ABORT: signing identity not in keychain: $SIGN_IDENTITY" >&2
    exit 1
  else
    echo "Signing macOS binaries..."
    for target in darwin-arm64 darwin-x64; do
      codesign --force --sign "$SIGN_IDENTITY" --identifier "$SIGN_IDENTIFIER" --timestamp "$OUTPUT_DIR/$BINARY_NAME-$target"
      echo "  signed $BINARY_NAME-$target"
    done
  fi
fi

echo "Built:"
ls -lh "$OUTPUT_DIR"

#!/bin/bash
set -e

cd "$(dirname "$0")/.."

OUTPUT_DIR="../web/binaries"
mkdir -p "$OUTPUT_DIR"

# Refuse to build if a stale src/*.js shadow is present — it would hijack
# import("./daemon.js") and silently bundle old code. The --compile step below
# bundles daemon.ts directly, so no pre-compiled daemon.js intermediate is needed.
bash scripts/guard-no-src-shadow.sh

echo "Building codecast binaries..."

# Build for each platform
# bun compile supports: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64

targets=(
  "darwin-arm64"
  "darwin-x64"
  "linux-arm64"
  "linux-x64"
  "windows-x64"
)

for target in "${targets[@]}"; do
  echo "Building for $target..."

  if [[ "$target" == "windows-x64" ]]; then
    outfile="$OUTPUT_DIR/codecast-$target.exe"
  else
    outfile="$OUTPUT_DIR/codecast-$target"
  fi

  bun build src/index.ts --compile --target="bun-$target" --minify --sourcemap --outfile="$outfile"

  echo "  -> $outfile"
done

# Re-sign the macOS binaries with a stable Developer ID identity. bun's
# --compile output is ad-hoc, linker-signed (Identifier=a.out), so its
# code-signing identity IS the content hash — every release looks like a
# brand-new app to macOS. TCC grants (e.g. the Documents-folder prompt when a
# user's projects live there) and Background Task Management items are keyed
# to that identity, so ad-hoc binaries re-prompt users after every
# self-update. A stable identifier + Developer ID cert makes grants survive.
# No hardened runtime: bun/JSC needs JIT, and TCC stability doesn't require it.
if [[ "$(uname)" == "Darwin" ]]; then
  SIGN_IDENTITY="${CODECAST_SIGN_IDENTITY:-Developer ID Application: Ashot Petrosian (WRG9THCK9Q)}"
  if [[ "${CODECAST_SKIP_SIGN:-}" == "1" ]]; then
    echo "WARNING: skipping macOS code signing (CODECAST_SKIP_SIGN=1) — ad-hoc binaries reset TCC grants on every update"
  elif ! security find-identity -v -p codesigning | grep -qF "$SIGN_IDENTITY"; then
    echo "ABORT: signing identity not found in keychain: $SIGN_IDENTITY" >&2
    echo "Install the Developer ID cert, set CODECAST_SIGN_IDENTITY, or set CODECAST_SKIP_SIGN=1 (ships ad-hoc binaries that re-prompt TCC on every update)." >&2
    exit 1
  else
    echo ""
    echo "Signing macOS binaries..."
    for target in darwin-arm64 darwin-x64; do
      codesign --force --sign "$SIGN_IDENTITY" --identifier sh.codecast.cli --timestamp "$OUTPUT_DIR/codecast-$target"
      echo "  signed codecast-$target"
    done
  fi
fi

echo ""
echo "All binaries built:"
ls -lh "$OUTPUT_DIR"

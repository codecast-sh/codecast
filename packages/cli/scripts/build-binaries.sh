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

echo ""
echo "All binaries built:"
ls -lh "$OUTPUT_DIR"

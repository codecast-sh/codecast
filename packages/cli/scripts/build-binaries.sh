#!/bin/bash
set -e

cd "$(dirname "$0")/.."

OUTPUT_DIR="../web/binaries"
mkdir -p "$OUTPUT_DIR"

echo "Rebuilding daemon.js from source..."
bun build src/daemon.ts --outfile src/daemon.js --target node

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

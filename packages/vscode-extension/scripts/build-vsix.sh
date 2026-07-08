#!/bin/bash
# Build the codecast VS Code / Cursor extension into a .vsix and stage it for
# the R2 upload (scripts/upload-binaries.sh → https://dl.codecast.sh/<name>).
#
# Built in an isolated copy so the monorepo's workspace: deps don't break a
# plain `npm install` inside the extension.
set -e
cd "$(dirname "$0")/.."
EXT_DIR="$(pwd)"
STAGE="$EXT_DIR/../web/public/binaries"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Copy sources (no node_modules/dist) into the isolated work dir.
rsync -a --exclude node_modules --exclude dist --exclude '*.vsix' "$EXT_DIR/" "$WORK/"
cd "$WORK"

npm install --silent
npx esbuild src/extension.ts --bundle --outfile=dist/extension.js \
  --external:vscode --format=cjs --platform=node --minify
npx --yes @vscode/vsce@3.9.2 package --no-dependencies -o codecast-blame.vsix

mkdir -p "$STAGE"
cp codecast-blame.vsix "$STAGE/codecast-blame.vsix"
cp codecast-blame.vsix "$EXT_DIR/codecast-blame.vsix"

echo ""
echo "Built codecast-blame.vsix → $STAGE/codecast-blame.vsix"

# Publish to R2 (https://dl.codecast.sh/codecast-blame.vsix) when --publish is
# passed. Uses the same wrangler OAuth login as scripts/deploy-all.sh.
if [ "${1:-}" = "--publish" ]; then
  echo "Publishing to R2…"
  npx wrangler r2 object put "codecast/codecast-blame.vsix" \
    --file "$STAGE/codecast-blame.vsix" \
    --content-type "application/octet-stream" --remote
  echo "Live at https://dl.codecast.sh/codecast-blame.vsix"
else
  echo "To publish:  scripts/build-vsix.sh --publish"
  echo "  (or: npx wrangler r2 object put codecast/codecast-blame.vsix --file <vsix> --remote)"
fi

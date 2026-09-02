#!/usr/bin/env bash
# Mirror the shared @platform packages from the canonical repo into this
# tree. The copy is what ships: Railway, the CLI release workflow and the
# desktop build all run from a fresh clone, so every dep points one level
# in (file:../../platform/packages/<name>) and never outside the checkout.
# Edit the canonical copy in ~/src/platform, then run this to refresh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${PLATFORM_SRC:-$HOME/src/platform/packages}"
PACKAGES=(analytics auth cli-kit desktop email engine flags keys snippets)
mkdir -p "$ROOT/platform/packages"
for p in "${PACKAGES[@]}"; do
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude '*.tsbuildinfo' \
    --exclude '*.probe.ts' \
    "$SRC/$p/" "$ROOT/platform/packages/$p/"
done
echo "vendored ${#PACKAGES[@]} packages from $SRC"

#!/usr/bin/env bash
# Mirror the shared @platform packages from the canonical repo into this
# tree. The copy under platform/packages is GENERATED: never edit it by hand.
# It is what ships, because Railway, the CLI release workflow and the desktop
# build all run from a fresh clone, so every dep points one level in
# (file:../../platform/packages/<name>) and never outside the checkout.
# Edit the canonical copy in ~/src/platform, then run this to refresh.
#
#   scripts/vendor-platform.sh          # refresh the mirror
#   scripts/vendor-platform.sh --check  # exit 1 if the mirror has drifted
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${PLATFORM_SRC:-$HOME/src/platform/packages}"
CHECK=false; [[ "${1:-}" == "--check" ]] && CHECK=true

# The set is whatever the workspace packages depend on, so adopting a new
# package is one dep line and a rerun, never a second list to maintain.
PACKAGES=$(grep -ho '"@platform/[a-z-]*": "file:../../platform/packages/[a-z-]*"' "$ROOT"/packages/*/package.json \
  | sed 's#.*platform/packages/\([a-z-]*\)"#\1#' | sort -u)
RSYNC=(rsync -a --delete --exclude node_modules --exclude dist --exclude '*.tsbuildinfo' --exclude '*.probe.ts')

drift=0
for p in $PACKAGES; do
  if $CHECK; then
    out=$("${RSYNC[@]}" -n -i "$SRC/$p/" "$ROOT/platform/packages/$p/" | grep -v '^\.d' || true)
    if [[ -n "$out" ]]; then echo "platform/packages/$p differs from $SRC/$p:"; echo "$out" | sed 's/^/  /'; drift=1; fi
  else
    mkdir -p "$ROOT/platform/packages/$p"
    "${RSYNC[@]}" "$SRC/$p/" "$ROOT/platform/packages/$p/"
  fi
done
if $CHECK; then
  [[ $drift -eq 0 ]] && echo "vendored platform packages match $SRC"
  exit $drift
fi
echo "vendored $(echo "$PACKAGES" | wc -w | tr -d ' ') packages from $SRC: $(echo $PACKAGES)"

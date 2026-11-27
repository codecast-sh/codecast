#!/bin/bash
# Fails when a local require in a packaged module is missing from the built
# app's asar: an app that ships that way dies at boot (v1.1.85: main.js
# required ./updaterNet but the asar didn't contain it). Run after the mac
# build, by release.sh and .github/workflows/cut-desktop-release.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

ASAR="dist/mac-arm64/Codecast.app/Contents/Resources/app.asar"
ASAR_LIST=$(npx asar list "$ASAR")
# Every packaged module, not just the entry points: osPermissions.js is what
# requires the native addon. A .node keeps its extension and must also sit
# on disk beside the asar (asarUnpack), or dlopen fails inside the archive.
# A require resolves from the requiring file's own folder (installedApps/
# requires ./engine and ../winInstaller), so normalize before the lookup.
for src in $(jq -r '.build.files[] | select(endswith(".js"))' package.json); do
  for mod in $(grep -oE 'require\("\.\.?/[^"]+"\)' "$src" | sed -E 's|require\("([^"]+)"\)|\1|'); do
    case "$mod" in *.js|*.mjs|*.node|*.json) ;; *) mod="$mod.js" ;; esac
    f="/$(python3 -c 'import os,sys; print(os.path.normpath(os.path.join(os.path.dirname(sys.argv[1]), sys.argv[2])))' "$src" "$mod")"
    if ! echo "$ASAR_LIST" | grep -qx "$f"; then
      echo "  ERROR: $src requires $mod but $f is not in the asar — add it to build.files"
      exit 1
    fi
    if [[ "$f" == *.node ]] && [ ! -f "${ASAR}.unpacked$f" ]; then
      echo "  ERROR: $f is inside the asar but not unpacked — add it to build.asarUnpack"
      exit 1
    fi
    echo "  $src -> .$f ok"
  done
done

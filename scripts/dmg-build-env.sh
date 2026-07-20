# Prepares the environment for electron-builder's DMG step, which breaks in
# bare (non-login) shells. Source this, then run the build with
# PATH="$DMG_BUILD_PATH". Used by scripts/deploy-all.sh and
# packages/electron/scripts/release.sh.
#
# Two failure modes both surface as a misleading "Command failed: which python"
# (dmg-builder runs vendored dmgbuild/core.py, and when that throws it falls
# back to `which python`, which macOS no longer ships, masking the real error):
#   1) `which python3` resolves to /usr/bin/python3 (the Xcode stub) or
#      Homebrew's default python3 (3.14 here has a broken libexpat link) --
#      neither can run dmgbuild. Shim the first python3 that CAN import its
#      deps. Real CPythons ignore argv[0], so symlinks work for them; the
#      Xcode stub dispatches on argv[0] (a symlink named `python` makes it
#      look up a CLT tool called `python`, which doesn't exist), so the
#      fallback wraps it in a script that keeps its own name.
#   2) a stale /Volumes/Codecast mount left by a previous failed build makes
#      core.py's mount step fail. Detach any leftover Codecast volume.
#
# DMG_BUILD_PATH puts /bin first (/usr/local/bin/ln doesn't support -s on this
# system, and electron-builder runs `ln -s /Applications`) and the shim before
# /usr/bin so it wins over the Xcode stub.

for _v in /Volumes/Codecast*; do
  [ -d "$_v" ] && hdiutil detach "$_v" -force 2>/dev/null || true
done

PY_SHIM=""
for _py in python3.12 python3.13 python3.11; do
  _p=$(command -v "$_py" 2>/dev/null) || continue
  "$_p" -c "import xml.parsers.expat, plistlib" 2>/dev/null || continue
  PY_SHIM=$(mktemp -d)
  ln -sf "$_p" "$PY_SHIM/python3"
  ln -sf "$_p" "$PY_SHIM/python"
  echo "   dmg-builder python: $_p (via shim $PY_SHIM)"
  break
done
if [ -z "$PY_SHIM" ] && /usr/bin/python3 -c "import xml.parsers.expat, plistlib" 2>/dev/null; then
  PY_SHIM=$(mktemp -d)
  printf '#!/bin/sh\nexec /usr/bin/python3 "$@"\n' > "$PY_SHIM/python"
  chmod +x "$PY_SHIM/python"
  cp -p "$PY_SHIM/python" "$PY_SHIM/python3"
  echo "   dmg-builder python: /usr/bin/python3 (via argv[0]-safe wrapper in $PY_SHIM)"
fi
[ -n "$PY_SHIM" ] || echo "   WARNING: no working python3 found for dmg-builder; DMG step may fail"

DMG_BUILD_PATH="/bin:${PY_SHIM:+$PY_SHIM:}/usr/bin:$PATH"

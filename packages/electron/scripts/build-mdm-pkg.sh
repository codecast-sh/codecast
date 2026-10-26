#!/bin/bash
# Build Codecast.pkg, the installer an IT admin uploads to their MDM (docs/mdm.md).
#
# It holds three things, installed for the whole Mac:
#   /Applications/Codecast.app                       the desktop app
#   /usr/local/bin/codecast (+ cast -> codecast)     the CLI, owned by root
#   /Library/LaunchAgents/sh.codecast.enroll.plist   runs `codecast mdm enroll`
#                                                    as each person who logs in
# plus a postinstall (packages/electron/mdm/scripts) that loads the enroll agent
# for whoever is logged in during the install.
#
# Apple silicon only: the desktop app is built for arm64 alone, so an Intel Mac
# would get a CLI and an app that does not open. The distribution refuses x86_64
# hosts rather than install half a product. A universal pkg is one lipo away for
# the CLI once the app ships an x64 build.
#
# Signing: productsign with "Developer ID Installer" when that identity is in a
# keychain (MDM_INSTALLER_IDENTITY overrides the name); then notarized with the
# App Store Connect API key (notarize.js's key, or APPLE_API_KEY/_ID/_ISSUER)
# and stapled. Without the identity it builds an unsigned pkg and says so: an
# MDM installs unsigned pkgs, but nothing else on a Mac will, and Jamf/Kandji
# both prefer a signed one.
#
# Inputs (each overridable):
#   APP=dist/mac-arm64/Codecast.app        from `npm run build` (signed + notarized)
#   CLI=../web/binaries/codecast-darwin-arm64  from packages/cli/scripts/build-binaries.sh
#   OUT_DIR=dist/mdm
# Usage: ./scripts/build-mdm-pkg.sh [--no-notarize]

set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$(pwd)"

APP="${APP:-$HERE/dist/mac-arm64/Codecast.app}"
CLI="${CLI:-$HERE/../web/binaries/codecast-darwin-arm64}"
OUT_DIR="${OUT_DIR:-$HERE/dist/mdm}"
INSTALLER_IDENTITY="${MDM_INSTALLER_IDENTITY:-Developer ID Installer: Ashot Petrosian (WRG9THCK9Q)}"
APP_IDENTITY="${MDM_APP_IDENTITY:-Developer ID Application: Ashot Petrosian (WRG9THCK9Q)}"
TEAM_ID="WRG9THCK9Q"
NOTARIZE=1
for arg in "$@"; do
  case "$arg" in
    --no-notarize) NOTARIZE=0 ;;
    *) echo "Usage: $0 [--no-notarize]" >&2; exit 1 ;;
  esac
done

fail() { echo "ERROR: $*" >&2; exit 1; }

[ -d "$APP" ] || fail "no app at $APP (build it with npm run build)"
[ -f "$CLI" ] || fail "no CLI binary at $CLI (build it with packages/cli/scripts/build-binaries.sh)"

SIGN_PKG=0
if security find-identity -v -p basic | grep -F "$INSTALLER_IDENTITY" >/dev/null; then
  SIGN_PKG=1
  # A signed pkg is notarized, and notarization needs the hardened runtime on
  # every executable inside (step 2), so the Application identity must be here too.
  security find-identity -v -p codesigning | grep -F "$APP_IDENTITY" >/dev/null \
    || fail "found \"$INSTALLER_IDENTITY\" but not \"$APP_IDENTITY\", which re-signs the CLI for notarization"
fi

# Both halves must be the signed release builds: the pkg signature covers the
# archive, not what is inside it, and Gatekeeper still checks the app.
codesign --verify --deep --strict "$APP" || fail "$APP does not pass codesign --verify"
# sed reads to the end: `grep -q` would stop at the match, codesign would die of
# SIGPIPE, and pipefail would fail a correctly signed input.
team_of() { codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
[ "$(team_of "$APP")" = "$TEAM_ID" ] || fail "$APP is not signed by team $TEAM_ID"
[ "$(team_of "$CLI")" = "$TEAM_ID" ] || fail "$CLI is not signed by team $TEAM_ID"
[ "$(lipo -archs "$APP/Contents/MacOS/Codecast")" = "arm64" ] || fail "expected an arm64 app"
[ "$(lipo -archs "$CLI")" = "arm64" ] || fail "expected an arm64 CLI"

APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
# The binary's own answer, not package.json: the tree may be ahead of the build.
CLI_VERSION=$(CODECAST_NO_AUTO_UPDATE=1 "$CLI" --version | tr -d '[:space:]')
[[ "$CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "could not read the CLI version (got: $CLI_VERSION)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/codecast-mdm-pkg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"
echo "Building Codecast.pkg: desktop $APP_VERSION, CLI $CLI_VERSION"

# 1. The app component. Not relocatable: Installer would otherwise follow the
#    bundle id to any other copy on disk (a dmg in Downloads) and update that.
mkdir -p "$WORK/app-root"
# Without quarantine or other copied xattrs. (pkgutil --payload-files still
# lists ._ entries: that is pkgbuild encoding the kernel's com.apple.provenance
# stamp, which cannot be removed; Installer folds them back into xattrs, so no
# ._ file reaches the disk.)
ditto --noextattr --noqtn "$APP" "$WORK/app-root/Codecast.app"
codesign --verify --deep --strict "$WORK/app-root/Codecast.app" || fail "the copied app no longer verifies"
pkgbuild --analyze --root "$WORK/app-root" "$WORK/app-components.plist" >/dev/null
# --analyze lists the nested helper apps and frameworks too; every one of them.
n=$(/usr/libexec/PlistBuddy -c "Print" "$WORK/app-components.plist" | grep -c "BundleIsRelocatable")
for ((i = 0; i < n; i++)); do
  /usr/libexec/PlistBuddy -c "Set :$i:BundleIsRelocatable false" \
    -c "Set :$i:BundleOverwriteAction upgrade" "$WORK/app-components.plist"
done
pkgbuild --root "$WORK/app-root" \
  --component-plist "$WORK/app-components.plist" \
  --install-location /Applications \
  --identifier sh.codecast.desktop.pkg \
  --version "$APP_VERSION" \
  "$WORK/app.pkg"

# 2. The CLI component: binary, alias, enroll agent, postinstall.
CLI_ROOT="$WORK/cli-root"
mkdir -p "$CLI_ROOT/usr/local/bin" "$CLI_ROOT/Library/LaunchAgents"
ditto --noextattr --noqtn "$CLI" "$CLI_ROOT/usr/local/bin/codecast"
chmod 755 "$CLI_ROOT/usr/local/bin/codecast"
# The release CLI is signed without the hardened runtime, which notarization
# requires. Re-sign this copy with it, plus the entitlements bun's JIT needs. The
# identifier and team stay the same, so the designated requirement, and every
# TCC grant keyed to it, still matches the self-updating CLI's.
if [ "$SIGN_PKG" = 1 ]; then
  codesign --force --sign "$APP_IDENTITY" --identifier sh.codecast.cli --timestamp \
    --options runtime --entitlements mdm/cli-entitlements.plist "$CLI_ROOT/usr/local/bin/codecast"
  # Run a copy: the CLI links `cast` beside whatever path it runs from.
  mkdir -p "$WORK/cli-check" && cp "$CLI_ROOT/usr/local/bin/codecast" "$WORK/cli-check/"
  [ "$(CODECAST_NO_AUTO_UPDATE=1 "$WORK/cli-check/codecast" --version | tr -d '[:space:]')" = "$CLI_VERSION" ] \
    || fail "the CLI does not run under the hardened runtime"
fi
ln -s codecast "$CLI_ROOT/usr/local/bin/cast"
ditto --noextattr --noqtn mdm/sh.codecast.enroll.plist "$CLI_ROOT/Library/LaunchAgents/sh.codecast.enroll.plist"
chmod 644 "$CLI_ROOT/Library/LaunchAgents/sh.codecast.enroll.plist"
plutil -lint "$CLI_ROOT/Library/LaunchAgents/sh.codecast.enroll.plist" >/dev/null
# Directories keep the system's own modes (root:wheel 755), so an install
# never loosens /usr/local or /Library.
chmod 755 "$CLI_ROOT/usr" "$CLI_ROOT/usr/local" "$CLI_ROOT/usr/local/bin" "$CLI_ROOT/Library" "$CLI_ROOT/Library/LaunchAgents"
pkgbuild --root "$CLI_ROOT" \
  --ownership recommended \
  --scripts mdm/scripts \
  --install-location / \
  --identifier sh.codecast.cli.pkg \
  --version "$CLI_VERSION" \
  "$WORK/cli.pkg"

# 3. The product archive: Apple silicon, macOS 13+ (the app's minimum).
cat > "$WORK/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Codecast</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check>
    <allowed-os-versions><os-version min="13.0"/></allowed-os-versions>
  </volume-check>
  <choices-outline>
    <line choice="default"><line choice="sh.codecast.desktop.pkg"/><line choice="sh.codecast.cli.pkg"/></line>
  </choices-outline>
  <choice id="default"/>
  <choice id="sh.codecast.desktop.pkg" visible="false"><pkg-ref id="sh.codecast.desktop.pkg"/></choice>
  <choice id="sh.codecast.cli.pkg" visible="false"><pkg-ref id="sh.codecast.cli.pkg"/></choice>
  <pkg-ref id="sh.codecast.desktop.pkg" version="$APP_VERSION" onConclusion="none">app.pkg</pkg-ref>
  <pkg-ref id="sh.codecast.cli.pkg" version="$CLI_VERSION" onConclusion="none">cli.pkg</pkg-ref>
</installer-gui-script>
EOF

UNSIGNED="$WORK/Codecast-unsigned.pkg"
productbuild --distribution "$WORK/distribution.xml" --package-path "$WORK" \
  --version "$APP_VERSION" "$UNSIGNED"

OUT="$OUT_DIR/Codecast-$APP_VERSION.pkg"
if [ "$SIGN_PKG" = 1 ]; then
  productsign --sign "$INSTALLER_IDENTITY" --timestamp "$UNSIGNED" "$OUT"
  pkgutil --check-signature "$OUT"
else
  cp "$UNSIGNED" "$OUT"
  echo ""
  echo "WARNING: no \"$INSTALLER_IDENTITY\" identity in any keychain; $OUT is UNSIGNED."
  echo "  Create a Developer ID Installer certificate for team $TEAM_ID (developer.apple.com > Certificates),"
  echo "  import it, and rerun. Unsigned pkgs cannot be notarized."
  NOTARIZE=0
fi

if [ "$NOTARIZE" = "1" ]; then
  KEY="${APPLE_API_KEY:-$HOME/.app-store-connect/AuthKey_KR5Y6LS448.p8}"
  KEY_ID="${APPLE_API_KEY_ID:-KR5Y6LS448}"
  ISSUER="${APPLE_API_ISSUER:-69a6de76-856e-47e3-e053-5b8c7c11a4d1}"
  [ -f "$KEY" ] || fail "no App Store Connect API key at $KEY (set APPLE_API_KEY or pass --no-notarize)"
  echo "Notarizing $OUT..."
  xcrun notarytool submit "$OUT" --key "$KEY" --key-id "$KEY_ID" --issuer "$ISSUER" --wait --timeout 30m
  xcrun stapler staple "$OUT"
  spctl -a -vv -t install "$OUT"
fi

shasum -a 256 "$OUT"
echo "Built $OUT"

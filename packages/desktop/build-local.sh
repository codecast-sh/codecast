#!/bin/bash
set -e
cd "$(dirname "$0")"

CONF=src-tauri/tauri.conf.json
PROD_URL="https://codecast.sh"
LOCAL_URL="http://local.codecast.sh"

echo "Swapping frontendDist to $LOCAL_URL..."
sed -i '' "s|\"frontendDist\": \"$PROD_URL\"|\"frontendDist\": \"$LOCAL_URL\"|" "$CONF"

cleanup() {
  echo "Restoring frontendDist to $PROD_URL..."
  sed -i '' "s|\"frontendDist\": \"$LOCAL_URL\"|\"frontendDist\": \"$PROD_URL\"|" "$CONF"
}
trap cleanup EXIT

echo "Building Codecast.app..."
npx @tauri-apps/cli@2 build --bundles app 2>&1

APP=$(find src-tauri/target/release/bundle -name "Codecast.app" -maxdepth 3 | head -1)
if [ -z "$APP" ]; then
  echo "Build failed - no .app found"
  exit 1
fi

echo ""
echo "Built: $APP"

# Patch Info.plist to allow HTTP for local dev server (ATS exception)
PLIST="$APP/Contents/Info.plist"
echo "Patching ATS to allow HTTP..."
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains dict" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains:local.codecast.sh dict" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains:local.codecast.sh:NSExceptionAllowsInsecureHTTPLoads bool true" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains:local.codecast.sh:NSIncludesSubdomains bool true" "$PLIST" 2>/dev/null || true

echo "Installing to /Applications..."
rm -rf /Applications/Codecast.app
cp -R "$APP" /Applications/Codecast.app
echo "Done. Launch Codecast from /Applications (requires dev server at $LOCAL_URL)"

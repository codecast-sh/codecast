#!/bin/bash
# Builds the installed-app shim: one universal (arm64 + x86_64) executable,
# build/CodecastAppShim, from Sources/*.swift. No-op when the binary is newer
# than every source. Codecast.app ships it in Resources (signed with the
# Developer ID) and install.js copies it into each app bundle.
set -e
cd "$(dirname "$0")"
OUT=build/CodecastAppShim
MIN=12.0
if [ -f "$OUT" ] && [ -z "$(find Sources build.sh -newer "$OUT" -type f)" ]; then exit 0; fi
mkdir -p build
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN" \
    -framework Cocoa -framework WebKit -framework UserNotifications -framework Carbon -framework ServiceManagement \
    -o "build/shim-$arch" Sources/*.swift
done
lipo -create build/shim-arm64 build/shim-x86_64 -output "$OUT"
rm -f build/shim-arm64 build/shim-x86_64
echo "appshim: built $OUT ($(lipo -archs "$OUT"))"

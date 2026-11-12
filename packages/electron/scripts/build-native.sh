#!/bin/bash
# Compiles native/notifications.mm into native/notifications.node and
# native/deviceKey.{swift,mm} into native/deviceKey.node (N-API, so
# the one binary loads in Electron and in node alike). Runs before every
# start/dev/build script; a no-op when each binary is newer than its sources.
# Non-macOS hosts skip: the addons are macOS-only and their absence reads as
# "unknown" (osPermissions.js) or no device key (deviceKey.js), never a crash.
set -e
cd "$(dirname "$0")/.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-native: not macOS, skipping native addons"
  exit 0
fi

# node_api.h ships with every node install next to its binary.
NODE_INCLUDE="$(dirname "$(node -p process.execPath)")/../include/node"
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "build-native: node_api.h not found under $NODE_INCLUDE" >&2
  exit 1
fi

# Whether OUT is missing or older than any of its sources or this script.
stale() {
  local out="$1"; shift
  [ -f "$out" ] || return 0
  [ "$0" -nt "$out" ] && return 0
  for src in "$@"; do [ "$src" -nt "$out" ] && return 0; done
  return 1
}

OUT=native/notifications.node
if stale "$OUT" native/notifications.mm; then
  clang++ -std=c++17 -ObjC++ -fobjc-arc -O2 -shared -undefined dynamic_lookup \
    -DNAPI_VERSION=8 -I"$NODE_INCLUDE" \
    -framework Foundation -framework UserNotifications -framework CoreGraphics \
    -o "$OUT" native/notifications.mm
  echo "build-native: built $OUT"
fi

# The Touch ID device key (deviceKey.js): CryptoKit is Swift-only, so the
# Swift half compiles to an object the N-API half links against.
OUT=native/deviceKey.node
if stale "$OUT" native/deviceKey.swift native/deviceKey.mm; then
  TARGET="$(uname -m)-apple-macos12"
  OBJ="$(mktemp -d)/deviceKey.o"
  xcrun swiftc -O -parse-as-library -target "$TARGET" -emit-object -o "$OBJ" native/deviceKey.swift
  clang++ -std=c++17 -O2 -shared -undefined dynamic_lookup -target "$TARGET" \
    -DNAPI_VERSION=8 -I"$NODE_INCLUDE" \
    -L"$(xcrun --show-sdk-path)/usr/lib/swift" -L/usr/lib/swift -Wl,-rpath,/usr/lib/swift \
    -framework Foundation -framework CryptoKit -framework LocalAuthentication -framework Security \
    -o "$OUT" native/deviceKey.mm "$OBJ"
  echo "build-native: built $OUT"
fi

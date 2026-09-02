#!/bin/bash
# Compiles native/notifications.mm into native/notifications.node (N-API, so
# the one binary loads in Electron and in node alike). Runs before every
# start/dev/build script; a no-op when the binary is newer than its source.
# Non-macOS hosts skip: the addon is macOS-only and its absence reads as
# "unknown" (osPermissions.js), never as a crash.
set -e
cd "$(dirname "$0")/.."

SRC=native/notifications.mm
OUT=native/notifications.node

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-native: not macOS, skipping $OUT"
  exit 0
fi
if [ -f "$OUT" ] && [ ! "$SRC" -nt "$OUT" ] && [ ! "$0" -nt "$OUT" ]; then
  exit 0
fi

# node_api.h ships with every node install next to its binary.
NODE_INCLUDE="$(dirname "$(node -p process.execPath)")/../include/node"
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "build-native: node_api.h not found under $NODE_INCLUDE" >&2
  exit 1
fi

clang++ -std=c++17 -ObjC++ -fobjc-arc -O2 -shared -undefined dynamic_lookup \
  -DNAPI_VERSION=8 -I"$NODE_INCLUDE" \
  -framework Foundation -framework UserNotifications \
  -o "$OUT" "$SRC"
echo "build-native: built $OUT"

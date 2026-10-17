#!/bin/bash
# Fresh install of the store shots build on this session's simulator, opened on
# the store shots bundle (Metro on :8095 with EXPO_PUBLIC_STORE_SHOTS=1).
# A fresh install also clears the app's SQLite cache of earlier fixture rows.
set -e
# This session's simulator (cast sim acquire), never "booted": with two
# simulators up, "booted" picks either.
SIM=${SIM:?set SIM to the UDID cast sim acquire printed}
APP=${APP:-/tmp/shots-dd/Build/Products/Debug-iphonesimulator/Codecast.app}
# Refuse a bundle without the flag: this pool simulator's keychain may hold a
# real sign-in, and without store shots mode the app would open that account.
curl -s "http://localhost:${PORT:-8095}/packages/mobile/index.bundle?platform=ios&dev=true" \
  | grep -q '"EXPO_PUBLIC_STORE_SHOTS"' || { echo "Metro on :${PORT:-8095} is not serving store shots mode (EXPO_PUBLIC_STORE_SHOTS=1)"; exit 1; }
xcrun simctl terminate "$SIM" com.ashotp.codecast 2>/dev/null || true
xcrun simctl uninstall "$SIM" com.ashotp.codecast 2>/dev/null || true
xcrun simctl install "$SIM" "$APP"
xcrun simctl status_bar "$SIM" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl launch "$SIM" com.ashotp.codecast >/dev/null
sleep 8
xcrun simctl openurl "$SIM" "com.ashotp.codecast://expo-development-client/?url=http%3A%2F%2Flocalhost%3A${PORT:-8095}"

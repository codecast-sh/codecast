#!/bin/bash
# Records the App Store preview's raw takes from the store shots build on this
# session's simulator (relaunch.sh first, app on the inbox's Status view).
# One take per scene, raw/take-<n>.mov; preview.sh cuts them together.
# Taps are in points on the iPhone 17 Pro.
set -u
# This session's simulator (cast sim acquire), never "booted": with two
# simulators up, "booted" picks either.
SIM=${SIM:?set SIM to the UDID cast sim acquire printed}
cd "$(dirname "$0")"
EVAL="bun ../scripts/hermes-eval.mjs"
ws() { curl -s http://localhost:${PORT:-8095}/json | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['webSocketDebuggerUrl'])"; }
tap() { cast sim tap -x "$1" -y "$2" >/dev/null 2>&1; }
take() {
  xcrun simctl io "$SIM" recordVideo --codec h264 --force "raw/take-$1.mov" >/dev/null 2>&1 &
  REC=$!
  sleep 1.5
}
cut_take() { sleep "${1:-1}"; kill -INT "$REC"; wait "$REC" 2>/dev/null; echo "take done"; }

# 1. The inbox, sorted by who acts next; open the question.
take 1
sleep 2.5
tap 201 324
cut_take 3

# 2. Answer it: tap the recommended option.
take 2
sleep 2
tap 186 582
cut_take 3.5

# 3. Team chat: the channel list, then #eng where the session answered.
tap 22 82; sleep 2
cast sim tap --label "Chat" >/dev/null 2>&1; sleep 3
take 3
sleep 2
tap 120 283
cut_take 4

# 4. The huddle in #eng, with live captions.
$EVAL "$(ws)" '(__storeShots.huddle(), 1)' 20000 >/dev/null 2>&1
xcrun simctl openurl "$SIM" "codecast://call"; sleep 3
take 4
cut_take 4.5

# 5. The Lock Screen strip. iOS may ask once more whether to keep allowing
# Live Activities on a later lock; answer it before the take, never on it.
$EVAL "$(ws)" '(__liveActivity.endAll(), 1)' 20000 >/dev/null 2>&1; sleep 1
$EVAL "$(ws)" '(__storeShots.lock(), 1)' 20000 >/dev/null 2>&1
sleep 2
xcrun simctl status_bar "$SIM" clear
cast sim button lock >/dev/null 2>&1; sleep 2
cast sim button lock >/dev/null 2>&1; sleep 3
if cast sim ui 2>/dev/null | grep -q "Always Allow"; then cast sim tap --label "Always Allow" >/dev/null 2>&1; sleep 2; fi
cast sim button lock >/dev/null 2>&1; sleep 2
take 5
cast sim button lock >/dev/null 2>&1
cut_take 4

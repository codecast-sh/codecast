#!/bin/bash
# boot-trace.sh <udid> <label> [seconds]: cold launch against Metro on 8083 and record a
# Hermes trace from the moment the JS runtime registers with the inspector, so
# module evaluation is in it. Read it with module-eval.py.
UDID=$1; O="${OUT:-/tmp/codecast-taps}/$2"; SECS=${3:-15}
HERE="$(cd "$(dirname "$0")" && pwd)"; /bin/mkdir -p "$O"
xcrun simctl terminate "$UDID" com.ashotp.codecast 2>/dev/null; sleep 3
xcrun simctl openurl "$UDID" "exp+codecast://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8083"
for _ in $(seq 1 400); do
  WS=$(curl -s localhost:8083/json | python3 -c "import json,sys;p=[x for x in json.load(sys.stdin) if x['webSocketDebuggerUrl'].endswith('page=1')];print(p[-1]['webSocketDebuggerUrl'] if p else '')" 2>/dev/null)
  [ -n "$WS" ] && break; sleep 0.05
done
bun "$HERE/hermes-trace.mjs" "$WS" "$SECS" "$O/trace.json" | tail -1
python3 "$HERE/trace-to-cpuprofile.py" "$O/trace.json" "$O/p.cpuprofile" | tail -1

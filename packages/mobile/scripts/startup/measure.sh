#!/bin/bash
# measure.sh <udid> <label> <port> [seconds]: cold launch of a dev client build against
# serve-update.mjs on <port>; writes boot marks and process CPU samples to $OUT/run-<label>.
UDID=$1; LABEL=$2; PORT=$3; SECS=${4:-75}
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${OUT:-/tmp/codecast-startup}/run-$LABEL"
/bin/mkdir -p "$OUT"; /bin/rm -f "$OUT"/*
xcrun simctl terminate "$UDID" com.ashotp.codecast 2>/dev/null; sleep 2
xcrun simctl spawn "$UDID" log stream --level debug --style compact --predicate 'process == "Codecast" AND eventMessage CONTAINS "[boot]"' > "$OUT/marks.log" 2>&1 &
LOGPID=$!
sleep 3
python3 "$HERE/sample.py" "$UDID" "$SECS" "$OUT/cpu.log" &
SAMPLER=$!
sleep 0.5
xcrun simctl openurl "$UDID" "exp+codecast://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$PORT"
wait $SAMPLER
kill $LOGPID 2>/dev/null
xcrun simctl io "$UDID" screenshot "$OUT/end.png" >/dev/null 2>&1
python3 "$HERE/summarize.py" "$OUT"

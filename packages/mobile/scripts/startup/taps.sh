#!/bin/bash
# taps.sh <udid> <label> <port> <sequence file>: cold launch the bundle served on
# <port> (serve-update.mjs, or Metro), wait, then run the sequence of taps. The
# bundle must be exported with EXPO_PUBLIC_PERF_PROBE=1 (lib/perfProbe), which
# logs one [tap] line per touch. Prints each tap's probe numbers beside the
# process CPU spent until the next tap (taps-cpu.py).
#
# A sequence file is shell: `t <x> <y>` taps a point and waits GAP seconds.
# WAIT (12) is the settle time after launch; TRACE=<seconds> also records a
# Hermes trace from the first tap (Metro only: the inspector lives there).
UDID=$1; LABEL=$2; PORT=$3; SEQ=$4
HERE="$(cd "$(dirname "$0")" && pwd)"; O="${OUT:-/tmp/codecast-taps}/$LABEL"
/bin/mkdir -p "$O"; /bin/rm -f "$O"/*
xcrun simctl terminate "$UDID" com.ashotp.codecast 2>/dev/null; sleep 2
xcrun simctl spawn "$UDID" log stream --level debug --style compact --predicate 'process == "Codecast" AND (eventMessage CONTAINS "[tap]" OR eventMessage CONTAINS "[boot]")' > "$O/log" 2>&1 &
LOGPID=$!; sleep 2
python3 "$HERE/sample.py" "$UDID" "${SAMPLE:-180}" "$O/cpu.log" &
SAMPLER=$!
# A run cut short must not leave its log stream and sampler behind.
trap 'kill $LOGPID $SAMPLER $TRACER 2>/dev/null' EXIT
xcrun simctl openurl "$UDID" "exp+codecast://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A$PORT"
sleep "${WAIT:-12}"
if [ -n "$TRACE" ]; then
  WS=$(curl -s "localhost:$PORT/json" | python3 -c "import json,sys;print([p for p in json.load(sys.stdin) if p['webSocketDebuggerUrl'].endswith('page=1')][-1]['webSocketDebuggerUrl'])")
  bun "$HERE/hermes-trace.mjs" "$WS" "$TRACE" "$O/trace.json" > "$O/trace.log" 2>&1 & TRACER=$!; sleep 2
fi
N=0
t() {
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' >> "$O/taps.txt"
  axe tap -x "$1" -y "$2" --udid "$UDID" >/dev/null 2>&1
  sleep "${GAP:-3}"; N=$((N+1)); xcrun simctl io "$UDID" screenshot "$O/s$N.png" >/dev/null 2>&1
}
. "$SEQ"
sleep 2; kill $LOGPID $SAMPLER 2>/dev/null; [ -n "$TRACER" ] && wait $TRACER
grep -o "\[boot\] [0-9]*ms [a-z-]*" "$O/log" | sed 's/\[boot\] //' | tr '\n' ' '; echo
python3 "$HERE/taps-cpu.py" "$O"

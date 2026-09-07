#!/bin/bash
# Repeats the forced re-paste-branch probe against a given daemon.ts snapshot.
# Usage: probe-runs.sh <label> <runs> <daemon-snapshot>
cd "$(dirname "$0")" || exit 1
label="$1"; runs="${2:-6}"; snapshot="$3"
out="/tmp/ct49750-probe-$label"
mkdir -p "$out"
cp "$snapshot" src/daemon.ts || exit 1
echo "daemon.ts <- $snapshot"
for i in $(seq 1 "$runs"); do
  timeout 600 bun test src/gatekeys.probe.test.ts > "$out/run$i.log" 2>&1
  echo "probe $i: $(grep -E '^ +[0-9]+ (pass|fail)' "$out/run$i.log" | tr -d '\n') | $(grep -o '\[probe\].*' "$out/run$i.log" | head -c 200)"
done

#!/bin/bash
# Repeats the D0 matrix's three claude cells against a given daemon.ts snapshot.
# Usage: matrix-runs.sh <label> <runs> <daemon-snapshot>
cd "$(dirname "$0")" || exit 1
label="$1"; runs="${2:-6}"; snapshot="$3"
out="/tmp/ct49750-$label"
mkdir -p "$out"
cp "$snapshot" src/daemon.ts || exit 1
echo "daemon.ts <- $snapshot"
for i in $(seq 1 "$runs"); do
  timeout 900 bun test src/messaging.e2e.test.ts -t "claude" > "$out/run$i.log" 2>&1
  echo "run $i: $(grep -E '^ +[0-9]+ (pass|fail)' "$out/run$i.log" | tr -d '\n')"
done

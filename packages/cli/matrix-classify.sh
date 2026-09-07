#!/bin/bash
# Classifies each matrix run: control-byte contamination (the defect under test)
# vs harness timeouts (machine load) vs other assertion failures.
dir="$1"
total_cells=0; contaminated=0; timedout=0; other=0
for f in "$dir"/run*.log; do
  [ -f "$f" ] || continue
  cells=$(grep -cE '^\(pass\) |^\(fail\) ' "$f")
  fails=$(grep -cE '^\(fail\) ' "$f")
  hooks=$(grep -c 'hook timed out for this test' "$f")
  # A control-byte failure prints the offending message in the expect() diff.
  cb=$(grep -cE 'Expected: false' "$f")
  total_cells=$((total_cells + cells)); timedout=$((timedout + hooks)); contaminated=$((contaminated + cb))
  other=$((other + fails - hooks - cb))
  echo "$(basename "$f"): cells=$cells fail=$fails  control_byte=$cb hook_timeout=$hooks other=$((fails - hooks - cb))"
done
echo "TOTAL cells=$total_cells  control_byte=$contaminated  hook_timeout=$timedout  other=$other"

# The proof after the build (LE8): the reproduction that failed before the fix
# passes now. Writes proof.json, red then green, for the change card, and
# fails the station while the reproduction still fails. Its last line is one
# JSON result, {"green", "why"}, which the run report reads as its sentence.
cd "$(cast ws path $worktree)" || exit 1
dir=$run_dir
clean() { tail -c 300 "$1" 2>/dev/null | tr -d '\000-\037\\"'; }
# A line cause whose miss lives only on recorded runs has no check to rerun:
# its proof is the checked line-proof.json, and the card says it is unscored.
if [ $category = line ] && [ ! -f "$dir/repro.sh" ]; then
  echo "a line cause with no rerunnable check: its miss is shown on recorded runs only ($(clean "$dir/line-proof.log"))"
  echo '{"green": true, "why": "no check to rerun: the problem shows on recorded runs only"}'
  exit 0
fi
name="$(head -n 1 "$dir/repro.name" 2>/dev/null | tr -d '\000-\037\\"')"
[ -n "$name" ] || name="Reproduction"
bash "$dir/repro.sh" > "$dir/green.log" 2>&1
code=$?
passed=false
[ "$code" -eq 0 ] && passed=true
# A line cause's red also names the recorded runs the line checked, which
# its check's summary leads with, so its head is kept rather than its tail.
before="$(clean "$dir/red.log")"
[ $category = line ] && before="$(head -c 300 "$dir/line-proof.log" 2>/dev/null | tr -d '\000-\037\\"')"
printf '{"before":[{"name":"%s","ok":false,"detail":"%s"}],"after":[{"name":"%s","ok":%s,"detail":"%s"}]}\n' \
  "$name" "$before" "$name" "$passed" "$(clean "$dir/green.log")" > "$dir/proof.json"
tail -n 40 "$dir/green.log"
if [ "$passed" = true ]; then
  printf '{"green": true, "why": "%s passes with the change"}\n' "$name"
else
  printf '{"green": false, "why": "%s still fails with the change"}\n' "$name"
fi
exit "$code"

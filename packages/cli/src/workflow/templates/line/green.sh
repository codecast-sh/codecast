# The proof after the build (LE8): the reproduction that failed before the fix
# passes now. Writes proof.json, red then green, for the change card, and
# fails the station while the reproduction still fails.
cd "$(cast ws path $worktree)" || exit 1
dir=$red.json.dir
clean() { tail -c 400 "$1" 2>/dev/null | tr -d '\000-\037\\"'; }
name="$(head -n 1 "$dir/repro.name" 2>/dev/null | tr -d '\000-\037\\"')"
[ -n "$name" ] || name="Reproduction"
bash "$dir/repro.sh" > "$dir/green.log" 2>&1
code=$?
passed=false
[ "$code" -eq 0 ] && passed=true
printf '{"before":[{"name":"%s","ok":false,"detail":"%s"}],"after":[{"name":"%s","ok":%s,"detail":"%s"}]}\n' \
  "$name" "$(clean "$dir/red.log")" "$name" "$passed" "$(clean "$dir/green.log")" > "$dir/proof.json"
tail -n 40 "$dir/green.log"
exit "$code"

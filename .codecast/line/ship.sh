# The ship station (line-profile.md LP4): the project's ship command lands the
# change its own way and prints one line saying what is true now, which goes
# on the task. Without one the line's merge step lands it.
cmd=$line.commands.ship
if [ -z "$cmd" ]; then
  echo "no ship command: the merge step lands the change"
  exit 0
fi
cd "$(cast ws path $worktree)" || exit 1
dir=$run_dir
mkdir -p "$dir"
bash -c "$cmd" > "$dir/ship.out" 2> "$dir/ship.log"
code=$?
tail -n 40 "$dir/ship.log"
said="$(grep -v '^[[:space:]]*$' "$dir/ship.out" | tail -n 1)"
[ -n "$said" ] || said="the ship command exited $code and said nothing"
echo "$said"
if [ "$code" -eq 0 ]; then
  cast task comment $task_id "Shipped: $said" -t progress
else
  cast task comment $task_id "Not shipped: $said" -t blocker
fi
exit "$code"

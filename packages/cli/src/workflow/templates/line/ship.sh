# The ship station (line-profile.md LP4): the project's ship command lands the
# change its own way and prints one line saying what is true now, which goes
# on the task. Without one the station runs Ship itself (docs/architecture/ship.md)
# on the run's branch when the run froze a session's change (flows.md FL4):
# a ship session opens the pull request and shepherds it, and merges only when
# the profile sets [line.merge] auto or the line's role holds a merge grant.
# A ship command exits 3 when the default branch moved past the branch since
# the rebase station put it there: the graph sends the run back to rebase.
cmd=$line.commands.ship
if [ -z "$cmd" ]; then
  # A change frozen from a session ships as the snapshot the run reviewed: its branch, never the session's live edits.
  frozen=$change_session
  out="$(cast ship run --task $task_id ${frozen:+--branch $branch} 2>&1)"
  code=$?
  echo "$out"
  said="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1)"
  [ -n "$said" ] || said="cast ship run exited $code and said nothing"
  if [ "$code" -eq 0 ]; then
    cast task comment $task_id "Shipping: $said" -t progress > /dev/null
  else
    cast task comment $task_id "Not shipped: $said" -t blocker > /dev/null
  fi
  exit "$code"
fi
wt="$(cast ws path $worktree)"
[ -n "$wt" ] && cd "$wt" || exit 1
dir=$run_dir
mkdir -p "$dir"
bash -c "$cmd" > "$dir/ship.out" 2> "$dir/ship.log"
code=$?
tail -n 40 "$dir/ship.log"
# Its one line is on stdout; a command that refused says why on stderr instead.
said="$(grep -v '^[[:space:]]*$' "$dir/ship.out" | tail -n 1)"
[ -n "$said" ] || [ "$code" -eq 0 ] || said="$(grep -v '^[[:space:]]*$' "$dir/ship.log" | tail -n 1)"
[ -n "$said" ] || said="the ship command exited $code and said nothing"
echo "$said"
if [ "$code" -eq 0 ]; then
  cast task comment $task_id "Shipped: $said" -t progress > /dev/null
elif [ "$code" -eq 3 ]; then
  # Exit 3: the default branch moved since the rebase. The run rebases again.
  cast task comment $task_id "Rebasing again: $said" -t progress > /dev/null
else
  cast task comment $task_id "Not shipped: $said" -t blocker > /dev/null
fi
exit "$code"

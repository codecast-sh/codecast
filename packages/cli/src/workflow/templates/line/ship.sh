# The ship station (line-profile.md LP4): the project's ship command lands the
# change its own way and prints one line saying what is true now, which goes
# on the task. Without one the station runs Ship itself (docs/architecture/ship.md)
# on the run's branch when the run froze a session's change (flows.md FL4):
# a ship session opens the pull request and shepherds it, and merges only when
# the profile sets [line.merge] auto or the line's role holds a merge grant.
# A ship command exits 3 when the default branch moved past the branch since
# the rebase station put it there: the graph sends the run back to rebase.
# It exits 7 when CI went red on the landing, with its brief already on the
# task as a blocker and printed on stdout: the graph sends the run back to the
# builder with that brief.
# Either way an exit 0 is only a claim: the change must be on origin's default
# branch (`cast flow landed`), whose commit goes to $run_dir/merge.json for
# Deploy, or Land fails with nothing merged. Ship's session merges its pull
# request after `cast ship run` returns, so that path waits for the merge, an
# hour at most, and a pull request still open then ends Land without a blocker.
dir=$run_dir
mkdir -p "$dir"
rm -f "$dir/merge.json" "$dir/deploy-clock.json"
# Where the change starts, read before the land command moves anything: a branch with nothing of its own since is
# never landed. It stays in $run_dir/since for a later rebase that finds the change already landed: once main holds
# the branch (a fast-forward), its fork is its own tip and says nothing.
git fetch -q origin "$default_branch" 2>/dev/null
if [ -s "$dir/since" ] && git merge-base --is-ancestor "$branch" "origin/$default_branch" 2>/dev/null; then
  since="$(cat "$dir/since")"
else
  since="$(git merge-base "$branch" "origin/$default_branch" 2>/dev/null)"
  printf '%s\n' "$since" > "$dir/since"
fi
kind=blocker
# After an exit 0: the commit on main that carries the change (recorded as the run's merge), or the line saying nothing was.
landed() {
  local out c
  out="$(cast flow landed --branch "$branch" --base "$default_branch" --files "$change_files" --since "$since" --out "$dir/merge.json" --run "$run_id" "$@" 2>&1)"
  c=$?
  [ "$c" -eq 0 ] && return 0
  said="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1)"
  code=1
  # Exit 2: the pull request is still open, which is no fault to raise.
  [ "$c" -eq 2 ] && kind=progress
  return 1
}
cmd=$line.commands.ship
if [ -z "$cmd" ] && [ "$ship_mode" = direct ]; then
  # A repository that ships straight to its default branch opens no pull request, so only its own command lands it.
  said="this repository ships straight to $default_branch ([ship] mode = \"direct\" in .codecast/workspace.toml), so no pull request lands it, and its line profile names no ship command: set [line.commands] ship in .codecast/line.toml"
  echo "$said"
  cast task comment $task_id "Not merged: $said" -t blocker > /dev/null
  exit 1
fi
if [ -z "$cmd" ]; then
  # A change frozen from a session ships as the snapshot the run reviewed: its branch, never the session's live edits.
  frozen=$change_session
  out="$(cast ship run --task $task_id ${frozen:+--branch $branch} 2>&1)"
  code=$?
  echo "$out"
  said="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1)"
  [ -n "$said" ] || said="cast ship run exited $code and said nothing"
  [ "$code" -eq 0 ] && ! landed --wait 3600 --node "$station_id" && echo "$said"
  if [ "$code" -eq 0 ]; then
    cast task comment $task_id "Merged: $said" -t progress > /dev/null
  else
    cast task comment $task_id "Not merged: $said" -t "$kind" > /dev/null
  fi
  exit "$code"
fi
wt="$(cast ws path $worktree)"
[ -n "$wt" ] && cd "$wt" || exit 1
bash -c "$cmd" > "$dir/ship.out" 2> "$dir/ship.log"
code=$?
if [ "$code" -eq 7 ]; then
  # Exit 7: CI is red. The command's blocker is the brief, so nothing more goes on the task. Its stdout, the same
  # brief, becomes the builder's file. Both files are this run's: $run_dir is the task's and every run on it shares
  # it, so a later run starts its rounds at 0 and a resumed one keeps its count. The JSON is a bare count, never a path.
  run=$run_id
  brief="$dir/${run}-ci-brief.md"
  count="$dir/${run}-ci-red-rounds"
  if grep -q '[^[:space:]]' "$dir/ship.out"; then
    cp "$dir/ship.out" "$brief"
  else
    echo "The ship command said CI is red (exit 7) and printed no brief: read the task's latest blocker comment." > "$brief"
  fi
  rounds=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 ))
  echo "$rounds" > "$count"
  echo "{\"ci_red_rounds\": $rounds}"
  exit 7
fi
tail -n 40 "$dir/ship.log"
# Its one line is on stdout; a command that refused says why on stderr instead.
said="$(grep -v '^[[:space:]]*$' "$dir/ship.out" | tail -n 1)"
[ -n "$said" ] || [ "$code" -eq 0 ] || said="$(grep -v '^[[:space:]]*$' "$dir/ship.log" | tail -n 1)"
[ -n "$said" ] || said="the ship command exited $code and said nothing"
[ "$code" -eq 0 ] && landed
echo "$said"
if [ "$code" -eq 0 ]; then
  cast task comment $task_id "Merged: $said" -t progress > /dev/null
elif [ "$code" -eq 3 ]; then
  # Exit 3: the default branch moved since the rebase. The run rebases again.
  cast task comment $task_id "Rebasing again: $said" -t progress > /dev/null
else
  cast task comment $task_id "Not merged: $said" -t "$kind" > /dev/null
fi
exit "$code"

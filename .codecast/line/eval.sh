# The eval station (LE8, line-profile.md LP4): the project's eval command
# writes $run_dir/reps.json (it picks the surfaces the branch owes and runs
# them on the base and on the branch); `cast line eval-result` turns the reps
# into eval-result.json for the card, and its exit code is the station's.
cd "$(cast ws path $worktree)" || exit 1
dir=$run_dir
cmd=$line.commands.eval
if [ -z "$cmd" ]; then
  cast task comment $task_id "This project's line profile names no eval command, so the eval station passed without evals and the change is unscored." -t progress
  echo "no eval command: passed with a note"
  exit 0
fi
mkdir -p "$dir"
rm -f "$dir/reps.json"
bash -c "$cmd"
code=$?
# No reps is no verdict on the change (exit 2), not a failed one (exit 1).
[ -s "$dir/reps.json" ] || { echo "the eval command exited $code and wrote no $dir/reps.json"; exit 2; }
cast line eval-result --reps "$dir/reps.json" --out "$dir/eval-result.json"

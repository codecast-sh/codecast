# The eval station (LE8, line-profile.md LP4): the project's eval command
# writes $run_dir/reps.json (it picks the surfaces the branch owes and runs
# them on the base and on the branch); `cast line eval-result` turns the reps
# into eval-result.json for the card, and its exit code is the station's.
# Its last line is one JSON result, {"why"}, which the run report reads as
# its sentence.
cd "$(cast ws path $worktree)" || exit 1
dir=$run_dir
cmd=$line.commands.eval
if [ -z "$cmd" ]; then
  cast task comment $task_id "This project's line profile names no eval command, so the eval station passed without evals and the change is unscored." -t progress
  echo "no eval command: passed with a note"
  echo '{"why": "no evals ran: the project names no eval command"}'
  exit 0
fi
mkdir -p "$dir"
rm -f "$dir/reps.json"
bash -c "$cmd"
code=$?
# No reps is no verdict on the change (exit 2), not a failed one (exit 1).
if [ ! -s "$dir/reps.json" ]; then
  echo "the eval command exited $code and wrote no $dir/reps.json"
  printf '{"why": "the evals could not score the change: the eval command exited %s and wrote no reps"}\n' "$code"
  exit 2
fi
cast line eval-result --reps "$dir/reps.json" --out "$dir/eval-result.json"
code=$?
case $code in
  0) if grep -q '"surfaces": \[\]' "$dir/eval-result.json" 2>/dev/null; then
       echo '{"why": "no evals ran: the change touches no eval surface"}'
     else
       echo '{"why": "the evals passed"}'
     fi ;;
  1) echo '{"why": "the evals found the change worse than the base"}' ;;
  *) echo '{"why": "the evals could not score the change: a surface has no scored rep on a side"}' ;;
esac
exit "$code"

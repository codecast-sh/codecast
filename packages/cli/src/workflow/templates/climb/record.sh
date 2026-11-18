# The climb's record (flows.md FL10): every way the climb ends passes here.
# The summary goes on the goal as an update and on the climb's task: the
# candidates tried, what separated, what overfit, what the guard refused,
# the cost against its spending limit, and how it ended. It never fails the run.
d="$run_dir/climb"
goal=$(cast climb status --dir "$d" --field goal)
[ -n "$goal" ] || goal=$(printf '%s' $goal_ref | sed -n 's/^\(in-[0-9]*\).*/\1/p')
sum=$(cast climb status --dir "$d" --summary)
[ -n "$sum" ] || sum="The climb ended before Frame wrote a card it could run, so nothing was tried."
echo "$sum"
if [ -n "$goal" ]; then
  cast goal update "$goal" "$sum" || echo "the summary could not be posted on $goal"
fi
cast task comment $task_id "$sum" -t progress || true
printf '{"why": "%s"}\n' "$(printf '%s' "$sum" | head -1 | tr -d '"\\')"
exit 0

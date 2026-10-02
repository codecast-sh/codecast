# Ground parked the cause (the-line-end-to-end.md LE5): it serves no goal, or
# it cannot be worked as it stands. Say so on the task and end the run. A
# missing fact goes out as a blocker so the people following the task see it.
kind=progress
[ $readiness = needs_context ] && kind=blocker
note="$(printf 'Parked at ground: readiness %s, goal %s. %s' $readiness $goal_ref $readiness_note)"
cast task comment $task_id "$note" -t "$kind"

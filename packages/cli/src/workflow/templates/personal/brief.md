The project's check and an independent reviewer read this session's change ($task_id), and it cannot land yet: $verdicts.output.

What the check ran, as JSON: each command with the line of the doc that names it, its exit code and the end of its output. A command's whole output is in `$run_dir/check-<n>.log`, counting from 1.

$check.json

What the reviewer found, as JSON. It counts only when its `round` is `$round.json.round`; `ship` with no findings means the review passed:

$review.json

Fix each failing command and each finding here, in this session's checkout: fix what is right, and where you disagree with a finding, say why in your reply. When there is nothing of yours to fix, end your turn without changing anything. Never push the default branch yourself, and never land the change another way: the run lands it, and a change with nothing left above origin/$default_branch after your turn stops the run. $change_keep $change_return, puts the change on the default branch again, and runs the check and a fresh review on it. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

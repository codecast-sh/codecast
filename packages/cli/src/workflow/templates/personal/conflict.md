The run could not put this session's change ($task_id) on the default branch: it conflicts with what landed there since the change was made.

$round.output

Bring this session's checkout up to date with origin/$default_branch and make the change fit it, keeping the default branch's own edits, then run the check. Never push the default branch yourself, and never land the change another way: the run lands it, and a change with nothing left above origin/$default_branch after your turn stops the run. $change_keep $change_return, puts the change on the default branch again, and runs the check and a fresh review on it. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

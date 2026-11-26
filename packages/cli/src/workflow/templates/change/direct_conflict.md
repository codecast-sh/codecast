Land could not put this session's change ($task_id) on $default_branch: it does not rebase cleanly onto what landed there since, or the check fails once it does. $human_message

$stop_reason

Bring this session's checkout up to date with $default_branch and make the change fit it, keeping $default_branch's own edits, then run the check. $change_return, runs the check, asks a fresh reviewer and lands it. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

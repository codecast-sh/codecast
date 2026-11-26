The project's check failed on this session's change ($task_id), so it cannot land on $default_branch yet. $human_message

$stop_reason

Fix what is right here, in this session's checkout, and where you disagree with a finding, say why in your reply. When there is nothing of yours to fix, end your turn without changing anything. $change_return, runs the project's check on it, asks a fresh reviewer and lands it. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

Check failed on this session's change ($task_id), which is going through a flow.

$stop_reason

Fix it here, in this session's checkout, and run the check yourself. When you end your turn the run freezes this session's edits again and runs Check on them, then every stage after it. The run is waiting on you: do not start it again. If it cannot be fixed here, pin `cast state --status blocked "<why>"` and the run stops.

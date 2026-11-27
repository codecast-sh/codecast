Local CI ran CI's checks on this session's change ($task_id) on this machine, before its pull request, and found it red. $human_message

What it said (the end of its output; every failure, in full, is in `$run_dir/local-ci.json`, and each step's log is in the directory its last line names):

$local_ci.output

A failing test file that passed when run again alone is listed under `flaky` there and left out here. Typechecking is left to CI. Fix each failure that is this change's, in this session's checkout. Local CI cannot tell a failure that main has too from one this change made: where a failure is not this change's, say why in your reply and leave it. $change_return and runs Local CI once more; if your turn changes nothing in the change, the pull request opens without it. If Local CI is still red after your turn, it does not send the change back again: the pull request opens and CI judges it against main. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

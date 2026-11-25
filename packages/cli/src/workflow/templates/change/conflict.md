Merge could not put this session's change ($task_id), pull request $pr.json.url, on the default branch: it conflicts with what landed there since CI tested it.

$merge.output

Bring this session's checkout up to date with the default branch and make the change fit it, keeping the default branch's own edits, then run the check. $change_return, pushes the change to the pull request again and runs CI and a fresh review on it. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

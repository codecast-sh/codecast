This session's change ($task_id), pull request $pr.json.url, conflicts with the default branch, so GitHub runs no CI on it and it cannot merge: $verdicts.json.why

Bring this session's checkout up to date with the default branch and make the change fit it, keeping the default branch's own edits, then run the check. $change_return, pushes the change to the pull request again and runs CI and a fresh review on it. The run is waiting on you: do not start it again. If you cannot go on without a person, pin `cast state --status blocked "<why>"` and the run stops.

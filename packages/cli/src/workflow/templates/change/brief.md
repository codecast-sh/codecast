CI and an independent reviewer read this session's change ($task_id) in its pull request, $pr.json.url, and it cannot merge yet: $verdicts.json.why. $human_message

What CI found, as JSON. Each entry under `failing` is a failure on this change, with its job, test, assertion, file, line and excerpt; `failing_count` says how many there are, and only the first ones are shown here, each excerpt cut short. Every failure, in full, is in `$run_dir/ci.json`: read it before you start. Each entry under `preexisting` also fails on the default branch at `tested_main_sha`.

$verdicts.json.ci_result

What the reviewer found, as JSON (verdict `ship` with no findings means the review passed; `reused` means the reviewer said ship on this same commit in an earlier round; null means the reviewer left no verdict, and the next round asks a fresh reviewer):

$verdicts.json.review_result

Fix each failure and each finding here, in this session's checkout: fix what is right, and where you disagree with a finding, say why in your reply. When there is nothing of yours to fix, end your turn without changing anything. $change_return, pushes the change to the pull request again and runs CI on it, and a fresh review unless the reviewer already said ship on the commit as it stands. The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

This session's change ($task_id) is on the default branch at $landed.json.sha, but its documented deploy failed: $deploy.json.note

What the deploy station ran, as JSON (each command with the line of the doc that names it, and its exit code):

$deploy.json

The deploy is what the project's docs say it is. Fix what broke where it lives: when it is outside this repository (a server's config, a deploys.conf, an ssh alias), fix it there; when the repository's deploy script or the doc that describes it is wrong, fix them here in this session's checkout, so that doing what the doc says deploys this project. Do not get it live by a route the docs do not name. Work in your own checkout. Anything you leave in the run's worktree is carried into the change and lands on main. Never push the default branch yourself, and never land the change another way: the run lands it, and a change with nothing left above origin/$default_branch after your turn stops the run. $change_keep $change_return; a fix in the repository goes through the check and a fresh review and lands, and then the documented deploy runs again (with only a fix outside the repository, it runs again at once). The run is waiting on you: do not start it again. If a person must act before you can go on, pin `cast state --status blocked "<why>"`: the run waits, and goes on when you next end your turn.

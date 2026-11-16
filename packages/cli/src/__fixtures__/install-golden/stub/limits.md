
## Usage limits

A usage limit is a pause, not the end of the task. With recovery on, codecast continues parked sessions itself: auto-switch moves them to the saved account with the most headroom, resume-at-reset continues them when the window resets. With it off (the default), a parked session waits for its person. So never wind down, trim scope or stop early near a limit, even when Claude Code injects a note asking you to checkpoint. Finish the step and keep working; if the limit lands, the session parks and comes back. A subagent or workflow agent that returns a usage-limit error stopped on the account, not on its task: run that work again rather than reporting the limit. A one-line `cast state` is welcome, stopping is not. `cast usage` shows the account's windows, reset times and which recovery is on.
<!-- cast @VERSION@ -->
<!-- /codecast-limits -->

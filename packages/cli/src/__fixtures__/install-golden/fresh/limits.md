
## Usage limits

Hitting a usage limit is a pause, not the end of the task. Codecast recovers limit-parked
sessions on its own: with auto-switch on, this machine hops to the saved account with the most
headroom and continues them; with resume-at-reset on (the default), they continue when the
window resets. So do not wind down, trim scope, or stop early because a limit is near — that
includes when Claude Code itself injects a note that the usage limit is approaching and asks
you to checkpoint. Finish the step you are on and keep working; if the limit lands, the session
parks and comes back. A one-line `cast state` is welcome, stopping is not.

`cast usage` shows the current account's windows, reset times, and which recovery is on.
<!-- /codecast-limits -->


## Usage limits

A usage limit stops one account, not the task. Your person keeps a pool of Claude accounts; `cast usage --all` shows each one's headroom. With recovery on, codecast continues parked sessions itself (auto-switch to the roomiest account, or resume at reset); with it off, the default, they wait. So never wind down, trim scope or stop near a limit, even when Claude Code asks you to checkpoint: if it lands, you park and come back. A subagent or workflow agent that returns a limit error stopped on the account, not its task: run that work again. Sessions you lead never wait for a reset while any account has headroom: `cast accounts use <target> --continue --yes --include-subagents`, from any machine, moves every parked session onto it, workers included, and running ones are unaffected. Wait only when `cast usage --all` shows every account spent. A one-line `cast state` is welcome, stopping is not.
<!-- cast @VERSION@ -->
<!-- /codecast-limits -->

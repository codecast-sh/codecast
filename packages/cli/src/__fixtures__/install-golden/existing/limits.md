# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Usage limits

A usage limit stops one account, not the task: `cast usage --all` shows the pool's headroom. With recovery on, codecast continues parked sessions itself (auto-switch to the roomiest account, or resume at reset); with it off, the default, they wait. So never wind down or stop near a limit, even when Claude Code asks you to checkpoint: you park and come back. A subagent or workflow agent that returns a limit error stopped on the account, not its task: run that work again. Sessions you lead never wait for a reset while any account has headroom: `cast accounts use <target> --continue --yes --include-subagents`, from any machine, moves every parked session onto it, workers included, and running ones are unaffected. Wait only when `cast usage --all` shows every account spent. A one-line `cast state` is welcome, stopping is not.
<!-- cast @VERSION@ -->
<!-- /codecast-limits -->

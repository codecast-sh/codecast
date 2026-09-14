---
name: cast-morning
description: Start the day with the state of everything that waits on the human or is ready to pick up: sessions that need input, pull requests with reviews or red checks, tasks ready to start, what teammates and overnight triggers did, unread team chat and mail. Use at the start of a working day, after time away, or when asked what needs attention.
argument-hint: "[since, e.g. 12h]"
---

The morning question is not what happened; it is what needs me, and what can
start now. Order the report that way.

## Gather, in parallel

```bash
cast sessions --state needs-input          # sessions a human must unblock
cast sessions --state done                 # delivered overnight, waiting to be read
cast pr ls                                 # reviews landed, checks red, branches behind
cast task ready                            # unclaimed work; cast task ls --assignee me -s in_progress
cast trigger ls                            # what ran overnight; cast trigger log <id> for a failure
cast feed -s <since> -n 20                 # teammates' sessions since you left
cast chat channels                         # unread counts; read the busy ones with --since
cast decisions --project .                 # decisions taken while you were away
gh run list --limit 5                      # CI on main
git fetch --all --prune && git status -sb  # local state, stashes, branches ahead
```

Read a session (`cast read`) only where the state line does not say what it
needs.

## Report

- Needs you: each session or PR with what it asks, one line, its short id.
- Ready to read: delivered work with the one line summary and its id.
- Ready to start: tasks from the queue, highest priority first.
- Overnight: what triggers and teammates did that changes today's plan.
- Broken: CI, a failed trigger, a session that died with output.

Omit empty sections. End with the one thing to do first.

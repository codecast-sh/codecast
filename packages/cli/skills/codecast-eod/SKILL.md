---
name: codecast-eod
description: Close the working day so nothing is lost and tomorrow starts cold without cost. Checks every live session for an honest pinned state, writes handoffs for work that will pause, arms follow ups that should run overnight, tidies the inbox, and leaves a short digest. Use at the end of a working day or before a long pause.
argument-hint: "[post]"
---

Tomorrow's first ten minutes are spent reconstructing today unless today
writes itself down before it ends.

## Sessions

```bash
cast sessions                      # every live session, grouped by who acts next
cast sessions --state working      # still running: leave them, note what they are on
```

For each session of yours that will pause: `cast state show <id>`; if the
pin is missing, stale, or says working when nothing is moving, write a real
one (`cast state --status <blocked|done|dormant>`) and, for work that took
more than an hour, a handoff doc (`/codecast-handoff`). Stash the finished
ones (`cast stash <id>`) so the inbox opens clean; kill only what is truly
done (`cast kill <id>`), and say which.

## Work items

Bound tasks still in progress: a progress comment with where they stand.
Tasks done today but not closed: close them with what was verified. Anything
blocked: the blocker named on the task.

## Overnight

Arm what should run while nobody watches, with a fresh session per run:

```bash
cast trigger add "<self contained brief>" --in 8h --spawn
cast trigger add "<what to check when CI finishes>" --on pr_checks_green --pr <n>
```

## Local state

`git status -sb` and `git stash list` for uncommitted or stashed work; name
it in the handoff so it is not mistaken for another session's tomorrow. Dev
servers and panes left running: list them with the attach command.

## Digest

Five lines at most: done, in progress, blocked, decided, first thing
tomorrow. With `post`, `cast chat send` it to the team channel; otherwise it
is the reply.

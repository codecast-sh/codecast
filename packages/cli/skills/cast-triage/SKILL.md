---
name: cast-triage
description: Tidy the fleet of sessions so the inbox shows only what needs a person. Reads every session by who acts next, resolves the stalled ones, stashes the finished, kills the dead, and surfaces the few that need the human with a one line ask each. Use when the inbox is crowded, after a fan out, or when asked what all these sessions are doing.
argument-hint: "[--label <name> | --mine]"
---

Every fleet tool exists because a person cannot track eight sessions at
once. Triage is the agent doing that tracking and leaving the person a
short list.

## Read

```bash
cast sessions [--label <name>] [--mine]        # grouped by who acts next
cast sessions --state needs-input --json       # the ones that claim a human
```

For each session under Needs Input: `cast state show <id>` and, when the pin
does not explain the ask, `cast read <id>` for the last few turns. Decide
whether it truly needs a human, is finished and never said so, is stuck on
something another session or you can supply, or is dead with output.

## Act

- Finished but unclassified: read its result, then `cast stash <id>`; the
  work is in its diff and the human can restore it.
- Stuck on a question you can answer from the code or another session's
  work: `cast send <id>` the answer.
- Waiting on a peer that already delivered: point it at the delivery.
- Dead, work complete: `cast kill <id>`. Dead, work incomplete: `cast
  restart <id>` and a message to continue from the pin.
- Truly needs the human: leave it, and write its ask in one line.

Never kill or stash a session another person owns without saying so; their
sessions get a message, not a gesture.

## Report

Two lists: what needs the human, one line each with the ask and the short
id; and what was tidied, with the action taken. The first list is the
deliverable; the second is the receipt.

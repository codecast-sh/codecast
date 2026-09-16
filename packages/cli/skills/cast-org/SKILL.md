---
name: cast-org
description: Look at the organization of agents and people around this work, then set it up or bring it up to date with the person, in this session. Reads what the code and the sessions say before it trusts a plan or a task, proposes seats, scopes and record fixes, takes the person's edits in plain words, and posts the result for them to accept. Use when asked who is working on what, to set up or review the org, to hire a lead or a chief of staff, or when the chart has drifted from reality.
argument-hint: "[init | review | status]"
---

The organization is people, standing roles with a scope, and the sessions
under them. This skill is that conversation, held wherever the person
already is. The org page does the same work with a chart and a pane; say so
once, and carry on here.

## Look first

```bash
cast org ls                      # who reports to whom, roles with their scopes
cast org health --json           # load, flags, stale records, span
cast org proposals               # anything already waiting for a person
```

An open proposal outranks a new one. Walk the person through what is waiting
rather than writing a second opinion beside it: name what it would change,
what the evidence says, and leave deciding to them.

## Ground in the work, not the records

Plans go stale and tasks finish without being closed, so a chart built on
the records describes a company that no longer exists. `cast org inputs
--json` carries the activity: which areas of the repository people commit
to, where sessions run, which plans and tasks the evidence says are done.
Read that before any seat is discussed, and propose the record fixes first.

## Propose

```bash
cast org init --here             # no roles yet: the analyzer prompt, in this session
cast org review --here           # roles exist: the same prompt in review mode
```

Follow the prompt it prints. It carries the capacity model, the grounding
rules, the standing versus program rule and the honesty rules; do not
restate or replace them here.

## Iterate with the person before posting

This is the part the weekly routine cannot do. Before writing anything,
show the shape in the thread: each proposed seat in one line with its scope,
who it reports to and the evidence for it, then the record fixes as counts.
Ask what is wrong with it. Take plain words ("growth is Sam's", "that plan
is dead", "one seat, not two") and fold them in. Repeat until the person
recognizes their own company.

```bash
cast org propose --spec proposal.json [--supersedes op-N]
```

Post once, at the end, and give them the link. Accepting is theirs: no
session may decide a staffing change.

## Then

Say where it landed and what is now true: the proposal id and its link, what
it would change in one line, and that the same review runs weekly once a
chief of staff holds the seat (`cast org staff`). Mention that the chart at
/org shows the same thing with ghosts they can accept one at a time.

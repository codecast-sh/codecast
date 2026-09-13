---
name: codecast-standup
description: Build a standup or digest for a time window from the team's agent sessions, commits, tasks, pull requests, calls and chat. Use for a daily standup, a weekly retro, or when asked what happened since yesterday or what a teammate has been doing.
argument-hint: "[1d|3d|1w] [--mine | -m <member>]"
---

Standup tools read one person's local logs. Codecast holds every teammate's
sessions, so the digest can cover the team, and each item can point at the
session that did the work.

## Gather, in parallel

The window defaults to one day. The scope defaults to the team; `--mine` or
`-m <member>` narrows it (both flags pass straight through to `cast feed`
and `cast search`).

```bash
cast feed -s <window> -n 40 [--mine | -m <member>]   # what sessions did
cast diff --today            # or --week: files and commits across sessions
cast task ls -a -s done      # closed work; cast task ls -s in_progress for open
cast pr ls                   # open pull requests and their state
cast calls -n 5              # cast call <id> for summary and action items
cast chat channels           # unread counts; cast chat read --channel <id> for decisions
cast decisions --project .   # decisions recorded in this window
git log --since="<window>" --oneline
```

Read a session (`cast read <id>`) only when its feed line is ambiguous; the
feed summaries carry most of it.

## Write it

Five short sections, each item one line with the session, task or PR short id
so it renders as a live reference: **Done**, **In progress**, **Blocked** (who
or what unblocks it), **Decisions** (what and why), **Next**. Group by person
when the scope is the team. A retro over a week adds one more section: what
was reverted, redone or abandoned, with the reason.

## Deliver

Print it here. On request, post it with `cast chat send --channel <id> -` or
publish it with `cast publish` for people outside the channel.

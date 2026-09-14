---
name: cast-standup
description: Build a standup or digest for a time window from the team's agent sessions, commits, tasks, pull requests, calls and chat. Use for a daily standup, a weekly retro, or when asked what happened since yesterday.
argument-hint: "[1d|3d|1w] [--mine | -m <member>] [post]"
---

Standup tools read one person's local logs. This reads what the whole team's
sessions did, plus the systems around them.

## Gather, in parallel

Default window is one day; `--mine` or `-m <member>` narrows the author.

```bash
cast feed -s <window> -n 40 [--mine | -m <member>]   # sessions: titles, edits, last turns
cast diff --today            # or --week: files and commits across sessions
cast task ls -s done -a      # closed work; cast task ls -s in_progress for what is open
cast task ready              # unclaimed work
cast pr ls                   # open pull requests and their state
cast decisions --project .   # decisions recorded in the window
cast calls -n 5              # then cast call <id> for the summary and action items
cast chat channels           # unread counts; cast chat read --channel <id> for the busy ones
git log --since="<window> ago" --oneline
```

Read a session (`cast read <id>`) only when the feed line does not say what
it delivered or why it stopped.

## Write

Five sections, each a short list, each item ending with the session, task or
pull request short id so it renders as a live reference:

- Done: what shipped, verified how.
- In progress: what is moving and who acts next.
- Blocked: what waits on a human, and which human.
- Decisions: what was decided and the reason, one line each.
- Next: what is queued, from `cast task ready` and the pinned states.

Lead each item with the outcome, not the activity. A session that ran for
four hours and delivered nothing goes under Blocked or is omitted, not under
Done. Omit any section with nothing in it.

## Post

If asked to post, `cast chat send --channel <id> -` with the digest on stdin,
or `cast publish` it as a page and put the link in the reply. Otherwise reply
with the digest and stop.

---
name: codecast-why
description: Explain why a line of code is the way it is. Follows the line through cast blame to the codecast session that wrote it and the message where it was decided, then answers from the author's own reasoning. Use when asked why code looks like this, who wrote it, what the intent behind a change was, or before changing a line whose purpose is unclear.
argument-hint: "<file>:<line> [question]"
---

`git blame` says who and when. This skill answers why, with the conversation
that produced the line as evidence. Never guess at intent when the history is
one command away.

## Find the session

```bash
cast blame --porcelain <file>:<line>          # one line
cast blame --porcelain -L <from>,<to> <file>  # a block; group lines by session
```

Each line carries the git commit and, when codecast attributed it, these keys:
`codecast-session` (short id), `codecast-message` (the message that made the
change), `codecast-url`, `codecast-title`, `codecast-author`. Lines with no
codecast keys predate attribution or came from a hand edit: fall back to the
commit summary and `cast search "<summary words>"` to find the session anyway,
and say that the link is inferred.

## Read the reasoning

```bash
cast read '<codecast-url>#msg-<codecast-message>' -c 6
```

That is the window around the exact message. The decision is usually a few
messages earlier than the edit, so widen `-c` until you see the user's ask or
the agent's reasoning. For a block written by several sessions, read each and
put them in time order: the last one explains the current shape, the earlier
ones explain what it replaced.

## Answer

Lead with the intent in the author's words, quoted and attributed to the
session's short id (it renders as a live reference). Then, only when the
history shows it: the alternative that was rejected and why, what else depended
on the choice, and whether a later session changed it. Close with
`cast link <session> <line>` so the reader can open the moment.

If the history is silent, say so plainly. An honest "the transcript shows the
edit but not the reason" beats a plausible story.

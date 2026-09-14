---
name: codecast-why
description: Explain why a line of code is the way it is. Traces the line through cast blame to the codecast session that wrote it and the message where it was decided, then answers from the author's own reasoning. Use when asked why code looks like this, who wrote it and why, or what the intent behind a change was.
argument-hint: "<file>:<line> [question]"
---

`git blame` answers who. This answers why, with the conversation that produced the line.

## Find the session

```bash
cast blame --porcelain <file>:<line>      # one line
cast blame --porcelain -L <a>,<b> <file>  # a block; group the lines by session
```

Each attributed line carries `codecast-session` (short id), `codecast-message`,
`codecast-url`, `codecast-title` and `codecast-author` beside the git fields.
A line with git fields only predates attribution: use the commit summary and
`cast search "<summary or key identifiers>"` to find the session by hand, and
say plainly when there is none.

## Read the reasoning

```bash
cast read '<codecast-url>#msg-<codecast-message>' -c 6
```

Widen the window (`-c 20`) when the decision was made earlier than the edit.
The message is where the file was written; the why is usually a few turns
before it, in the user's ask or in the assistant's plan. For a block written by
several sessions, read each and note the order: the later session may have
changed the intent of the earlier one.

## Answer

Lead with the intent in the author's words, quoted, with the session short id
so it renders as a live reference. Then, only if the history shows them: the
alternatives considered, what depended on this choice, and whether a later
session changed it. Mint a link the reader can open with
`cast link <session> <message line>`.

Do not guess. If the transcript does not contain a reason, say the line is
attributed but unexplained, and offer what the surrounding code suggests as a
separate, clearly marked inference.

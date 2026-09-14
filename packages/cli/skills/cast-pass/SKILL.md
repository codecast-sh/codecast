---
name: cast-pass
description: Hand this session to a teammate so it lands in their inbox with everything they need. Pins where the work stands and what is next, adds them as an owner, and sends them the brief. Use when work should continue under someone else, when a decision is theirs, or when asked to pass, hand over, or assign a session.
argument-hint: "<member> [note]"
---

A session passed without a brief is a transcript the teammate has to read
from the top. The pin and the message are what make it a handoff.

## Pin

`cast state --status blocked` with a first line that stands alone for
someone who has not read the thread, then what is verified, what is open,
and `Next:` naming the first thing they should do. If the work is more than
an hour deep, write the handoff doc first (`/cast-handoff`) and put its
id in the pin.

## Own

```bash
cast own <member>            # adds them; the session sits in both inboxes
cast own <session> <member>  # a different session of yours
```

They get a notification, and the session surfaces under Needs Input in
their inbox with your name on it. Use `cast disown` on yourself only if the
work is entirely theirs now.

## Brief

`cast send` to this session's id is pointless; the teammate reads the pin.
When the note argument is given, or when the pass needs a reason the pin
does not carry, post it where they will see it: the bound task
(`cast task comment <id>`) or the team channel with their handle
(`cast chat send --channel <id> "@<handle> …"`), one message. If the task
should change assignee, `cast task update <id> --assignee <member>`.

Then stop. The next move is theirs.

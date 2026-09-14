---
name: cast-ask-team
description: Ask the team a question without blocking on it. Posts the question to the team channel with the context needed to answer it cold, parks this session as dormant, and continues when an answer arrives. Use when a question is for a person who is not in this thread, when the human is away, or when asked to check with the team.
argument-hint: "<question> [--channel <id>] [@handle]"
---

A question parked in prose stalls the session until someone happens to read
the thread. A question in the team channel reaches the person who can
answer it, and the session sleeps in the meantime.

## Ask once, completely

```bash
cast chat channels
cast chat send --channel <id> - <<'MSG'
@<handle or nobody> <the question in one sentence>
Context: <what you found, in two lines, so nobody has to open the session>
Options: <A, B, or the default you will take if nobody answers by <time>>
Session: @<this session's short id>
MSG
```

Mention a person only when the question is theirs; a bare question reaches
whoever reads the channel. Mentioning this session's short id means a
reply on the thread is delivered here as a session message, which is the
wake.

## Park

Pin `cast state --status dormant` naming the thread as the wake, and keep
working on everything that does not depend on the answer. When nothing
else can proceed, end the turn.

If a default is safe to reverse, arm a fallback so silence does not stall
the work: `cast trigger add "<take the default and note it in the thread>"
--in <time>`.

## Resume

When the reply lands: act on it, reply on the same thread with what was
done in one line, and cancel the fallback trigger if one was armed.

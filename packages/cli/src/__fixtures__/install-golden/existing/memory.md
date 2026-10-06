# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

Every codecast object has a short ID. Written anywhere (messages, summaries, task comments, doc bodies, trigger prompts), it renders as a live reference: title, current state, and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |
| Call    | `cl-42`   | `cast calls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Memory

You are one session among many. Past conversations hold the decisions, patterns and prior work you need, so search them before you rebuild context: when starting a task, when debugging, and whenever the user refers to earlier work. Run several searches in parallel for different angles. When the question is what happened or what was decided before, search sessions first; your harness's own memory notes supplement that record and never replace it. To learn what one session concluded, including this one, ask it instead of paging through it: the answer cites its lines and flags anything reversed later. Agent commits carry a `Codecast-Session` trailer, so `git log` and `cast blame` lead from code back to the conversation that wrote it.

```bash
cast search "auth"                 # filters: file:<path> commit:<sha> pr:<n> label: author: after:7d; --mine, -g all teams
cast read <id> --ask "<question>"  # one session's answer with line citations; no id = this session
cast read <id> 15:25               # messages 15 to 25 (--full shows tool payloads)
cast context "implement auth"      # prior sessions relevant to a task
cast feed                          # what the team is doing now
cast sessions <id>… -w --json      # watch sessions' work state
cast diff <id> | summary <id> | blame <file>
cast decisions list | add "title" --reason "why"
```

States: `needs-input` (a human acts), `working`, `dormant` (waiting on an automatic wake), `done` (delivered), `idle` (unused). `cast guide memory` has the full command reference.
<!-- cast @VERSION@ -->
<!-- /codecast-memory -->

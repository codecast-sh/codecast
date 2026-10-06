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

## Thread state

Pin a short state on this session saying where the work stands. The human sees it above the composer and on the inbox card, so they learn the situation without reading back.

**End every turn by declaring who acts next** with `--status`. It decides where the session files in the human's inbox, and it is how you keep from becoming noise:

- `blocked`: a human must act first (answer, grant, decide). Files under **Needs Input** and claims their eyes, so declare it only when true.
- `done`: delivered, nothing stalled; read at leisure.
- `dormant`: a machine wakes you (a trigger you armed, a background task, another session's reply). Only when you can **name the wake** in the text; if you can't say what resumes you, you are `blocked`.
- `working` (the default): still moving.

`done` and `dormant` cover only the turn that declares them, and a message from the human takes the pin down, so declare again at the end of each turn. Never park an ask in prose and go dormant: queue it with `cast decide`, then declare dormant.

The first line, plain and unlabeled, names the work **now** for a reader with no context: plain words, no task IDs or shorthand. Later lines carry detail (`Status:`, `Next:`, `Blocked:` render as labels); keep only lines that carry information.

```bash
cast state --status dormant "Waiting on CI run 8841; tr-42 re-checks at 3pm"
cast state --status done "Shipped: all four fixes verified in the browser"
cast state --status blocked - <<'EOF'   # multi-line, exact newlines preserved
Migrating the sync layer to wake signatures
Blocked: needs a prod key before the last check
EOF
```

`cast guide state` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-state -->

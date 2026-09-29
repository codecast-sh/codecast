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

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Thread state

Pin a short state on this session saying where the work stands. The human sees it above the composer and on the inbox card, so they learn the situation without reading back: most valuable on long threads, parked ones, and ones shared across sessions.

A state has three parts: the **first line**, plain and unlabeled, says what this session is working on; `--status` declares who acts next; later lines carry detail (`Status:`, `Next:`, `Blocked:` render as labels).

**End every turn by declaring who acts next.** `--status` decides where the session files in the human's inbox when your turn ends; it is how you keep from becoming noise.

- `blocked`: a human must act first (answer, grant, decide). Files under **Needs Input** and pulls a stashed session back into the inbox; it claims the human's eyes, so declare it only when true.
- `done`: delivered, nothing stalled; read at leisure. Files under **Done**.
- `dormant`: a machine wakes you (a trigger you armed, a Monitor or background task, another session's reply). Files under **Dormant**, quiet until the wake. Only when you can **name the wake** in the text; if you can't say what resumes you, you are `blocked`.
- `working` (the default): still moving.

`done` and `dormant` cover only the turn that declares them: after the wake's turn, declare again, or the session returns to Needs Input. Never park an ask in prose and go dormant; queue it with `cast decide` (advisory when you can proceed), then declare dormant. Every settle you leave undeclared is a card the human must open to learn it needed nothing.

The first line names the work **now**, not the thread's opening goal, so rewrite it when the work moves on. It stands alone for a reader with no context: plain words, no task IDs, dates or shorthand the thread invented. To keep it short, cut references and detail, never meaning.

```bash
cast state --status dormant "Waiting on CI run 8841 — tr-42 re-checks at 3pm"
cast state --status blocked - <<'EOF'   # multi-line, exact newlines preserved
Migrating the sync layer to wake signatures
Status: rewrite done, tests green
Blocked: needs a prod key before the last check
EOF
cast state --status done "Shipped — all four fixes verified in the browser"
cast state                           # print the current state
cast state clear                     # remove it
cast state show <session_id>         # read another session's state
```

Write for someone who has been away: what is happening, what it waits on, what comes next, and whether anything is theirs to decide. Keep only lines that carry information; a `Next:` with no real step or a `Blocked:` saying "nothing" is padding.

Update it when the answer changes: a phase ends, you get blocked, you hand off, you go quiet. A message from the human takes the pin down (your declaration was answered), so declare again at the end of that turn; a send from another session or a trigger wake leaves it standing. Clear it only when it stops being true or useful: a state waiting on something that already arrived is worse than none, and one you stopped maintaining reads as abandoned.

Pin one on any thread that will run long, park on something outside your control, or share work with other sessions. Even on a short thread, a one-line `--status done` at the end files it where it belongs.
<!-- cast @VERSION@ -->
<!-- /codecast-state -->

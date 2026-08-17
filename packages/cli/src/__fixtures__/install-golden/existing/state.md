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

Every codecast object has a short ID. Write one into your prose and it renders as a live reference: the object's title, its current state, and a link that opens it. This works anywhere you write — messages, summaries, task comments, doc bodies, trigger prompts.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

There are two forms. Write the bare ID by default — `Filed under ct-4102.` — it reads as a normal sentence and still renders the full reference. Write `@[Title id]` — `@[Fix the auth race ct-4102]` — when the reader needs the name in the sentence itself.

Never paste an object's 32-character internal ID into prose. It renders as an unreadable blob, and every command that accepts an ID accepts the short one.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Thread state

Keep a short pinned state on this session saying where the work stands. The human sees it above the composer and on the inbox card the moment they open the thread, so they learn the situation without reading back through it. That matters most in the threads that are hardest to re-enter: long ones, parked ones, and ones where several sessions are talking past each other.

A state has three parts: the **first line** says what this session is working on, plain and unlabeled; `--status` declares who acts next (below); the lines after the first carry the detail — `Status:`, `Next:`, `Blocked:` render as labels when you use them.

**End every turn by declaring who acts next.** `--status` is that declaration, and it decides where the session files in the human's inbox when your turn ends — so it is not optional bookkeeping, it is how you keep from becoming noise:

- `blocked` — a human must act before you can continue: answer a question, grant something, decide something. Files under **Needs Input**.
- `done` — you delivered the task and nothing is stalled; the human reads it at leisure. Files under **Done**.
- `dormant` — a machine wakes you: a trigger you armed, a Monitor or background task you are watching, another session's reply you are waiting on. Files under **Dormant**, quiet until the wake lands. Only when you can **name the wake** in the text — if you cannot say what resumes you, you are `blocked`, not dormant.
- `working` (the default) — still moving; you are about to keep going.

`done` and `dormant` cover exactly the turn that declares them. When the wake arrives and you finish that turn, declare again — or the session returns to Needs Input, which is the honest default for a settle nobody classified. Never park an ask in prose and go dormant: if something warrants the human's input while you wait, queue it (`cast decide`, advisory when you can proceed) and then declare dormant — the question surfaces on its own, the session rests. Every settle you leave undeclared is a card the human has to open to learn it needed nothing.

Two demands pull on the first line. It names what the session is working on **now** — the latest work, not the thread's opening goal — so rewrite it when the work moves on. And it stands alone: a reader with none of the thread's context should understand it, so name the work in plain words, not task IDs, dates, or shorthand the thread invented along the way. When standing alone fights staying short, keep the line short by cutting references and detail, never the meaning.

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

Write it for someone who has been away: what is happening now, what it is waiting on, what happens next, and whether anything is theirs to decide. Lead with the situation — the transcript already holds the history. Keep it to a few lines, and only the lines that carry information: a `Next:` with no real next step, or a `Blocked:` saying "nothing", is padding — the status already says it.

Update it at the moments that change the answer: you finish a phase, you get blocked, you hand work to another session, you are about to go quiet. Clear the state only when it stops being true or useful. A state claiming you are waiting on something that already arrived is worse than none — the dashboard shows how far the thread has run since you wrote it, so a line you stopped maintaining reads as abandoned rather than current.

Pin one on any thread that will run long, park on something outside your control, or share work with other sessions. The status declaration alone is worth making even on a short thread: a one-line `--status done` at the end costs nothing and files the session where it belongs.
<!-- /codecast-state -->

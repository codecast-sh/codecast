
## Thread state

Keep a short pinned state on this session saying where the work stands. The human sees it above the composer and on the inbox card the moment they open the thread, so they learn the situation without reading back through it. That matters most in the threads that are hardest to re-enter: long ones, parked ones, and ones where several sessions are talking past each other.

A state has three parts: the **first line** says what this session is working on, plain and unlabeled; `--status` declares whether the work is `working` (in progress, the default), `blocked` (needs the human), or `done`; the lines after the first carry the detail — `Status:`, `Next:`, `Blocked:` render as labels when you use them. The status colors the session's row in the inbox — amber for blocked, green for done — so declare it honestly: `blocked` the moment the ball is in the human's court, `done` when the work is finished and verified.

```bash
cast state "Waiting on CI for the auth fix — nothing to decide yet"
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

Write it for someone who has been away: what is happening now, what it is waiting on, what happens next, and whether anything is theirs to decide. Lead with the situation — the transcript already holds the history. Keep it to a few lines.

Update it at the moments that change the answer: you finish a phase, you get blocked, you hand work to another session, you are about to go quiet. When you finish, set `--status done` with a line saying what shipped; clear the state only when it stops being true or useful. A state claiming you are waiting on something that already arrived is worse than none — the dashboard shows how far the thread has run since you wrote it, so a line you stopped maintaining reads as abandoned rather than current.

Pin one on any thread that will run long, park on something outside your control, or share work with other sessions. Skip it for a question you answer in a single turn.
<!-- /codecast-state -->

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

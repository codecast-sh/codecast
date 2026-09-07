
## Thread state

A pinned, agent-maintained status per thread (cast state). Adds `cast state "…"` so an agent keeps a short pinned state on its session: what it is working on, whether that work is in progress, blocked on you, or done, and the detail behind it. It shows above the composer and on the inbox card — the status colors the row, so blocked and finished sessions stand out in the list. The agent rewrites it as the work moves; the dashboard shows how far the thread has run since it was last written, so a neglected one reads as stale rather than current.

Run `cast guide state` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
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
<!-- cast @VERSION@ -->
<!-- /codecast-references -->


## Forks & Sessions

Delegate nested workers, hand off independent inbox threads, or run a prompt. For delegated implementers, reviewers and audits that report back to you, use `cast spawn --subagent -- "<task>"`: workers nest under this session on any agent backend. Watch their returned IDs with `cast sessions <id> -w --json`. Plain `cast spawn` and `cast fork` create independent inbox threads: use them only when the human asks for threads they will steer separately. A label or plan binding does not nest a worker. `cast exec` is print mode for every harness: run a prompt, print the result, exit. `cast switch` continues this session under a different agent or model, without forking.

Run `cast guide forks` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-forks -->

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

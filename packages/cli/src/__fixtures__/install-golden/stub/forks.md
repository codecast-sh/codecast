
## Forks & Sessions

Branch or spawn sessions into the inbox, or run a harness in print mode. Adds `cast fork` and `cast spawn` so a session can hand work to your inbox. `fork` branches the current conversation N ways from a message point; `spawn` starts fresh sessions. Both land in your inbox as independent threads — unlike subagents, which report back to the agent that launched them. `spawn --subagent` makes such a worker explicitly: the new session nests under its parent as a subagent row, on any agent backend. `cast exec` is print mode for every harness: run a prompt, print the result, exit. `cast switch` continues this session under a different agent or model, without forking.

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

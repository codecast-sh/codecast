
## Workflows

Execution graphs with approval gates (cast workflow). Adds `cast workflow` for running .cast files — directed graphs in DOT syntax where each node is an agent session, a shell command, or a human approval gate. Workflows only run when you explicitly invoke them.

Run `cast guide workflows` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-workflows -->

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
| Flow    | `flow:change` | `cast flow ls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a sentence and renders in full. A flow ID alone on a line draws the flow, each step open to its prompt. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as a blob, and every command takes the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

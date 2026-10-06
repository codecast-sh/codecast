
## Workflows

Workflows are DOT execution graphs with loops, conditions and human approval gates, bound to a task or plan. Nodes are agent sessions, shell commands, approval gates or conditionals; the dashboard shows progress and gate buttons.

```bash
cast workflow run flow.cast --task ct-N     # or --plan pl-N
cast workflow list | runs | push
```

`cast guide workflows` shows the graph syntax and the line commands.
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

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

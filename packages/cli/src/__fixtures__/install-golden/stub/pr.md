
## Pull requests (cast pr)

Review and steer pull requests from the shell (cast pr). Adds `cast pr`: list and inspect pull requests, hold notes on lines of the diff and send them as one review with a verdict, answer and resolve review threads, and bind a session as a pull request's owner. A review submitted through codecast also reaches the owning session as one message.

Run `cast guide pr` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-pr -->

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

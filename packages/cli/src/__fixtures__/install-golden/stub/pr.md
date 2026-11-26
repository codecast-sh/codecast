
## Pull requests (cast pr)

Review and steer pull requests from the shell (cast pr). Adds `cast pr`: list and inspect pull requests, hold notes on lines of the diff and send them as one review with a verdict, answer and resolve review threads, and bind a session as a pull request's owner. A review submitted through codecast also reaches the owning session as one message.

Run `cast guide pr` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-pr -->

## Referencing objects

Every codecast object has a short ID. Written anywhere (a message, comment, doc or prompt), it renders as a live reference: title, state and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |
| Call    | `cl-42`   | `cast calls` |
| Flow    | `flow:change` | `cast flow ls` |
| Deploy  | `dp-1972` | `cast line deploy targets` |
| Issue   | `eg-2242` | `cast events groups` |
| Metric  | `mw-12`   | `cast metrics ls` |
| Replay  | `rp-311@1:23` | `cast replay ls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a sentence and renders in full. An ID alone on its line is a live card (a metric's chart, an issue's last 72h, a flow's steps); stack them for a dashboard. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as a blob, and every command takes the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

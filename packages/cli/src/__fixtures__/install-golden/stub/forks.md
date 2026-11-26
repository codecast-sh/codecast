
## Forks & Sessions

Delegate nested workers, hand off independent inbox threads, or run a prompt. For delegated implementers, reviewers and audits that report back to you, use `cast spawn --subagent -- "<task>"`: workers nest under this session on any agent backend. Each settling worker wakes you; `cast sessions <id> --until` waits for them. Plain `cast spawn` and `cast fork` create independent inbox threads: use them only when the human asks for threads they will steer separately. A label or plan binding does not nest a worker. `cast exec` is print mode for every harness: run a prompt, print the result, exit. `cast switch` continues this session under a different agent or model, without forking.

Run `cast guide forks` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-forks -->

## Referencing objects

Every codecast object has a short ID. Written anywhere (a message, comment, doc or prompt), it renders as a live reference: title, state and a link.

- Session `jx7c6zk`: `cast feed`, `cast search`, `cast context`
- Task `ct-4102`: `cast task ls`, `cast task ready`
- Plan `pl-88`: `cast plan ls`
- Trigger `tr-42`: `cast trigger ls`
- Doc `doc:<id>`: `cast doc ls`, `cast doc search`
- Call `cl-42`: `cast calls`
- Flow `flow:change`: `cast flow ls`
- Deploy `dp-1972`: `cast line deploy targets`
- Issue `eg-2242`: `cast events groups`
- Metric `mw-12`: `cast metrics ls`
- Replay `rp-311@1:23`: `cast replay ls`

Write the bare ID by default (`Filed under ct-4102.`); it reads as a sentence and renders in full. An ID alone on its line is a live card: a metric's chart, an issue's last 72h, a flow's steps. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as a blob, and every command takes the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

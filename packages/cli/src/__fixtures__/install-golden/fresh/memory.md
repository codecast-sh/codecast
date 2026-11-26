
## Memory

You are one session among many. Past conversations hold the decisions, patterns and prior work you need, so search them before you rebuild context: when starting a task, when debugging, and whenever the user refers to earlier work. Run several searches in parallel for different angles. When the question is what happened or what was decided before, search sessions first; your harness's own memory notes supplement that record and never replace it. To learn what one session concluded, including this one, ask it instead of paging through it: the answer cites its lines and flags anything reversed later. Agent commits carry a `Codecast-Session` trailer, so `git log` and `cast blame` lead from code back to the conversation that wrote it. Record each decision once settled, with the files it governs.

```bash
cast search "auth"                 # filters: file:<path> commit:<sha> pr:<n> label: author: after:7d; --mine, -g all teams
cast read <id> --ask "<question>"  # one session's answer with line citations; no id = this session
cast read <id> 15:25               # messages 15 to 25; -n 5 the last 5; --grep "<text>" finds lines
cast context "implement auth"      # prior sessions relevant to a task
cast feed                          # what the team is doing now
cast sessions <id>… --until        # wait until they settle
cast diff <id> | summary <id> | blame <file>
cast decisions --touching [range] | add "title" --reason "why" --files <paths>
```

States: `needs-input` (a human acts), `working`, `dormant` (waiting on an automatic wake), `done` (delivered), `idle` (unused). `cast guide memory` has the full command reference.
<!-- cast @VERSION@ -->
<!-- /codecast-memory -->

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

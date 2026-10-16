
## Thread state

Pin a short state on this session saying where the work stands. The human sees it above the composer and on the inbox card, so they learn the situation without reading back.

**End every turn by declaring who acts next** with `--status`. It decides where the session files in the human's inbox, and it is how you keep from becoming noise:

- `blocked`: a human must act first (answer, grant, decide). Files under **Needs Input** and claims their eyes, so declare it only when true.
- `done`: delivered, nothing stalled; read at leisure.
- `dormant`: a machine wakes you (a trigger you armed, a background task, another session's reply, a blocker on the task you hold: a PR, a decision, a time). Only when you can **name the wake** in the text; if you can't say what resumes you, you are `blocked`.
- `working` (the default): still moving.

`done` and `dormant` cover only the turn that declares them, and a message from the human takes the pin down, so declare again at the end of each turn. Never park an ask in prose and go dormant: queue it with `cast decide`, then declare dormant.

The first line says where the work stands **now**, for a reader with no context: one thought, about 60 characters, plain words; if it waits on someone, name them. Then up to three lines, one line each, only when they carry something:

- `You:` what the human must do or decide, with the exact command (in backticks), link or choice
- `Done:` what is finished, short items joined by ` · `; proof counts ("tests green")
- `Next:` what happens next and when, in local time: the running job, your next step, or what wakes you

Leave IDs, hashes, branches, paths and UTC stamps in the transcript unless one is what the human must type, and never repeat the first line or write a line that says "nothing".

```bash
cast state --status done "Shipped: all four fixes verified in the browser"
cast state --status dormant - <<'EOF'   # multi-line, exact newlines preserved
Waiting on CI for the sync fix
Done: fix pushed · unit tests green
Next: 3 PM re-check, then merge if green
EOF
cast state --status blocked - <<'EOF'
Release is waiting on a signing key
You: add it to the repo secrets: `gh secret set SIGN_KEY < key.p12`
Next: re-run the release, then verify the download
EOF
```

`cast guide state` has the rest.
<!-- cast @VERSION@ -->
<!-- /codecast-state -->

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

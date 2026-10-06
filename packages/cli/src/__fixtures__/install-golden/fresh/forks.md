
## Forks & Sessions

Choose by who owns the result. **Work you delegate and report back on goes to `cast spawn --subagent`**: implementers, reviewers, parallel audits, workers under a plan you drive. They nest under this session, run on any agent backend, and you deliver the combined result. Use them instead of your harness's built-in subagent tool for delegated work; that tool stays fine for a quick read-only search inside one turn.

Plain `cast spawn` and `cast fork` create independent threads in the human's inbox for them to steer separately. Use them only when the human asks; if the handoff is your idea, propose it first. Parallelism, a fresh context, another agent, a label or a worktree do not decide ownership. A brief that says "report back to me" describes a worker.

```bash
cast spawn --subagent -- "<task>"                # a worker under this session; -- ends the options
cast spawn --subagent --agent codex -- "<task>"  # a worker on another backend
cast spawn --subagent -- - - <<'EOF'             # several briefs in one heredoc, split at lines of ---
…first brief…
---
…second brief…
EOF
cast fork "<direction>" ["<direction>" ...]      # human-requested branches of this conversation
cast exec "<prompt>"                             # run now, print the result, exit (no inbox card)
cast switch --agent codex                        # continue THIS session on another agent (or --model)
```

Multi-line prompts go through `-` and a heredoc, never `"$(cat file)"`, which mangles formatting. Every launch starts at once and knows only what you give it, so seed each with a sharp, self-contained brief, and tell the human in one line what runs where.

**Workers** are full sessions: `cast send <id>` for follow-ups, `cast read <id>` for results. A worker that settles wakes you with a message naming it, so after delegating you can end your turn; `cast sessions <id>… -w --json` follows them live (`done` means delivered, `needs_input` means read it). Report the combined result yourself.

**Forks** branch this conversation just before the latest user message. With several directions you take the first in place and each other becomes a branch, so issue one `cast fork` with all of them and carry on with the first. When forking is your own idea, pass `--tip`. A branch receives its direction as its human's next message and reports to nobody: never message, monitor or coordinate branches.

`--cloud` on `spawn` or `fork` runs the session on the person's cloud host, starting from this checkout as it stands, and `cast migrate` moves sessions between machines when the human asks. `cast guide forks` covers cloud hosts, folder sync, labels and migration.
<!-- cast @VERSION@ -->
<!-- /codecast-forks -->

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

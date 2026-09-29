# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

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

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Forks & Sessions

Choose by who owns the result. **Work you delegate and report back on goes to `cast spawn --subagent`**: implementers, reviewers, parallel audits, workers under a plan you drive. They nest under this session; you manage them and deliver the combined result. A request to build a feature or run work in parallel does not by itself ask for separate inbox threads.

Plain `cast spawn` and `cast fork` create independent threads in the human's inbox for the human to steer separately. Use them only when the human asks; if the handoff is your idea, propose it first. Parallelism, a fresh context, another agent, a label or a worktree do not decide ownership. A brief that says "report back to me" describes a worker: use `--subagent`.

```bash
cast spawn --subagent -- "<task>"             # worker under THIS session; -- keeps the prompt from being read as [parent]
cast spawn --subagent --agent codex "<task>"  # worker on another backend, still yours to manage
cast spawn "<independent thread>"             # only for a human-requested inbox handoff
cast fork "<direction>" ["<direction>" ...]   # human-requested branches; you take the first direction
cast exec --agent grok "review this diff"     # run now, print the result, exit (no inbox card)
cast switch --agent codex                     # continue THIS session under another agent
cast spawn --subagent -- - <<'EOF'            # multi-line brief via stdin
…goal, numbered steps, constraints, exact newlines…
EOF
```

Multi-line prompts go through `-` and a heredoc, never `"$(cat file)"`, which mangles formatting. Several `-` args split one heredoc into one prompt each at lines containing only `---`, so a whole fan-out fits in one call:

```bash
cast fork - - <<'EOF'
…first branch's brief…
---
…second branch's brief…
EOF
```

**Spawned sessions** start fresh, with no shared history, in this project (`-C <dir>` for elsewhere). Plain `cast spawn` makes an inbox card even when an agent calls it. A label or a task/plan binding does not nest it; `--subagent` does. A subagent is a full session on any backend: brief it, `cast send <id>` follow-ups, `cast read <id>` its results, and fold them into your work. Bare `--subagent` nests under the session running the command and `--subagent <session>` under another; a prompt right after the bare flag needs `--`. Watch the returned IDs with `cast sessions <id> [<id>…] -w --json`: `done` means delivered, `needs_input` means read it to learn whether it finished or is blocked. Workers are omitted from top-level lists and label filters but answer when named. Tell the human what you delegated, and report the results yourself.

**Forks** branch this conversation. Each branch keeps the history up to the fork point (by default just before the latest user message, so the fork request never enters a branch; `--at <line>` picks another spot, `-s <id>` forks another session). When forking is your own idea, pass `--tip`: there is no fork request to strip, and the default would drop the human's real latest message. With two or more directions you take the first in place and each other becomes a branch, so issue ONE `cast fork` with all N directions and carry on with the first instead of ending the turn to report a roster. One direction spins off a single branch while you continue. `--all-branches` leaves this thread out of the fan-out. A branch receives its direction as its human's next message: it doesn't know it is a fork and reports to nobody. Never message, monitor, wait on or coordinate branches; write each direction as a complete instruction for a thread reading it cold.

**Cloud hosts.** `--cloud` on `cast spawn` or `cast fork` runs the session on the person's cloud host, starting from this checkout as it stands: uncommitted and gitignored files travel, dependency and build folders are rebuilt there. The host carries their agent config, shell, logins and CLIs; on it `$CODECAST_CLOUD` is `1`. A cloud session's folder can be kept in step with a copy on the laptop, both ways (`cast sync start <session>` from the laptop). When something you expect is missing on the host, `cast sync status` says why, and `cast sync pull <path>` fetches it from the laptop (a file that stayed there, one outside the repo, or `--ref <branch>` for a branch only the laptop has) rather than recreating it; `cast sync push` sends your changes to the laptop copy. What a repo needs on a host (system packages, services, setup commands) belongs in the `[host]` table of `.codecast/workspace.toml`, and what should or should not travel in its `[sync]` table.

Every launch starts working immediately and knows only what you give it (plus, for a fork, the history up to the fork point), so seed each with a sharp, self-contained prompt. When you launch several, tell the human in one line what runs where, then continue.

Labels: a fork inherits the parent's label; `--label <name>` overrides it, or labels a spawn, and is created if new: `cast spawn --subagent --label rollout "<task>" "<task>"`. A label groups work without changing inbox visibility: `cast sessions --label rollout` lists independent sessions, while nested workers are watched by ID.

**`cast exec`** runs a prompt on any harness, prints the result and exits; the process is the session, with no inbox card. Use it for a result you need now, and `spawn --subagent` for a worker you manage across turns.

```bash
cast exec "summarize this repo"
cast exec --agent grok --model grok-4.6 --effort high "review the diff"
git diff | cast exec --agent claude --model sonnet "write a commit message"
```

**`cast switch`** keeps THIS session when you need a different agent or model; don't fork for that.

```bash
cast switch --agent codex              # continue here under Codex
cast switch --model opus               # same agent, different model
cast switch --agent claude --model sonnet
cast switch --agent codex --fork       # a new session instead
```

A divider ("now using Codex") lands in the thread and the conversation id stays. A provider switch replaces this process, so stop talking as the old agent; a model switch on the same provider usually doesn't.

### Moving sessions between machines

`cast migrate` moves many sessions at once between a laptop and a cloud host, either way, losing nothing: a mid-turn session finishes its turn first, messages sent during the move arrive on the destination, and the agent is told which machine it is on now. Use it when the human asks; when it's your idea, propose it first, since it changes where their terminals are.

```bash
cast migrate start --to linux --label rollout            # every session filed under "rollout" → the cloud host
cast migrate start --to macbook --from linux             # everything on the cloud host → the laptop
cast migrate start --to linux jx7c6zk jx7dhfh            # named sessions (short ids)
cast migrate start --to linux --project platform --dry-run   # preview what would move, what would not, and why
cast migrate ls | show <batch> | cancel <batch> | retry <batch>
```

`--to` and `--from` take a device id prefix or a label substring (`cast remote hosts` lists them). Selectors combine: `--label`, `--from`, `--project <path or name>`, `--all`, and short ids. `--dry-run` first when the selector is broad: it names each skip and why (already there, not a Claude Code session, machine offline). `--wait <minutes>` caps how long a mid-turn session may finish before it is interrupted (default 10; 0 interrupts at once). A batch runs on the machine holding the files and reports per session; tell the human what moved from `cast migrate show <batch>`.
<!-- cast @VERSION@ -->
<!-- /codecast-forks -->

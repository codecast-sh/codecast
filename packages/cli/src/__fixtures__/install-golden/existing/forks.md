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

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Forks & Sessions

Choose by who owns the result. **For work you delegate and report back on, use `cast spawn --subagent`.** This includes implementers, reviewers, parallel audits, and workers under a plan you are driving. They nest under this session; you manage them and deliver the combined result. A request to build a feature or run work in parallel does not by itself ask for separate inbox threads.

Plain `cast spawn` and `cast fork` create independent threads in the human's inbox, for the human to steer separately. Use them when the human explicitly asks for those independent threads; if that handoff is your idea, propose it first. Parallelism, a fresh context, a different agent, a label, and an isolated worktree do not decide ownership. If the brief says "report back to me", the session is your worker: include `--subagent`.

```bash
cast spawn --subagent -- "<task>"             # worker under THIS session; -- keeps the prompt out of [parent]
cast spawn --subagent --agent codex "<task>"  # worker on a different backend, still yours to manage
cast spawn "<independent thread>"             # only for a human-requested inbox handoff
cast fork "<direction>" ["<direction>" ...]   # human-requested branches; you take the first direction
cast exec --agent grok "review this diff"     # run now, print the result, exit (no inbox card)
cast switch --agent codex                     # continue THIS session under a different agent
cast spawn --subagent -- - <<'EOF'            # multi-line worker briefing via stdin
…goal, numbered steps, constraints — exact newlines preserved…
EOF
```

For multi-line prompts, pass `-` and feed the body via heredoc — never `"$(cat file)"`, which mangles formatting. Several `-` args split one heredoc into one prompt per `-`, separated by lines containing only `---` — so a whole fan-out of multi-line briefs fits in one invocation:

```bash
cast fork - - <<'EOF'
…first branch's brief…
---
…second branch's brief…
EOF
```

`cast fork` branches the current conversation — each branch keeps the full history up to the fork point (just before the latest user message by default, so the fork request itself never enters a branch; `--at <line>` picks another spot, `-s <id>` forks a different session), then pursues its own direction. Use it when the thread splits into distinct paths worth exploring in parallel. When forking is your own idea rather than the human's request, pass `--tip` — there is no fork request to strip, and the default would drop the human's real latest message.

With two or more directions, THIS thread is one of them: you take the first direction and continue with it in place, and each remaining direction becomes a branch. When the human asks for work in N forks, issue ONE `cast fork` with all N directions, then carry on with the first as your own work — do not end the turn to report a roster. One direction spins off a single branch while you continue whatever you were doing. `--all-branches` keeps you out of the fan-out when the human wants this thread left as is.

A branch receives its direction as its human's next message, exactly as if the person had typed it there. It does not know it is a fork, it has nobody to report back to, and it must not be treated as a worker: do not message, monitor, or wait on a branch, and do not build coordination between branches. Write each direction as a complete, self-contained instruction for a thread that will read it cold. The branches run independently and the human steers them from the inbox.

Both spawn modes start fresh sessions with no shared history, in the current project (`-C <dir>` for elsewhere). Plain `cast spawn` defaults to an inbox card even when called by an agent. A label or a task/plan binding does not nest it; `--subagent` does.

`cast spawn --subagent` creates a full session on any agent backend, nested under its parent. Brief it, watch it, `cast send <id>` it follow-ups, `cast read <id>` its results, and fold what it finds back into your own work. Bare `--subagent` uses the session running the command; pass `--subagent <session>` to name a parent explicitly. When the prompt comes immediately after the bare flag, separate it with `--`: `cast spawn --subagent -- "<task>"`. Watch the returned IDs with `cast sessions <id> [<id>…] -w --json`, then read their results. Workers are omitted from top-level lists, including label filters, but always answer when named. A `done` transition means delivered; `needs_input` requires reading whether the worker finished or is blocked. Tell the human what you delegated, and report the results yourself.

`cast exec` runs a prompt on any harness, prints the result, and exits. There is no inbox card: the process is the session. Use it when you need a result directly from the command; use `spawn --subagent` for a worker you will manage across turns.

```bash
cast exec "summarize this repo"
cast exec --agent grok --model grok-4.6 --effort high "review the diff"
git diff | cast exec --agent claude --model sonnet "write a commit message"
```

Every launch starts working immediately. Nested workers stay under their parent; independent spawns and fork branches appear in the human's inbox. A session only knows what you give it — for forks, plus the history up to the fork point — so seed each with a sharp, self-contained prompt. When you launch several, tell the human in one line what runs where, then continue your work.

Labels carry across a fork by default: a branch inherits the label you'd filed the parent under. Pass `--label <name>` to override it, or to label a spawn, which starts with no label. The label is created if it doesn't exist: `cast spawn --subagent --label rollout "<task>" "<task>"`. A label groups work; it does not change inbox visibility. Watch nested workers by their returned IDs; `cast sessions --label rollout` lists independent sessions with that label.

Stay on THIS session when you need a different agent or model. Do not fork unless you want a parallel branch the human will steer separately.

```bash
cast switch --agent codex              # continue here under Codex
cast switch --model opus               # same agent, different model
cast switch --agent claude --model sonnet
cast switch --agent codex --fork       # optional: a new session instead
```

A divider lands in the thread ("now using Codex"). The conversation id does not change. A provider switch replaces this process — do not keep talking as if you are still the old agent. A model switch on the same provider usually does not.

### Moving sessions between machines

Sessions run on one machine each — a laptop or a cloud host — and `cast migrate` moves MANY of them at once, in either direction, without losing anything: a session mid-turn finishes its turn first, messages sent during the move wait and arrive on the destination, and the agent gets a note saying which machine it is on now. Use it when the human asks to move work ("send everything labeled x to the linux box", "bring my sessions back to the laptop"); when moving is your own idea, propose it first — it interrupts nothing, but it changes where the human's terminals are.

```bash
cast migrate start --to linux --label rollout            # every session filed under "rollout" → the cloud host
cast migrate start --to macbook --from linux             # everything on the cloud host → the laptop
cast migrate start --to linux jx7c6zk jx7dhfh            # named sessions (short ids)
cast migrate start --to linux --project platform --dry-run   # preview: what would move, what would not, and why
cast migrate ls | show <batch> | cancel <batch> | retry <batch>
```

`--to` and `--from` take a device id prefix or a label substring (`cast remote hosts` lists them). Selectors combine: `--label`, `--from`, `--project <path or name>`, `--all`, plus explicit short ids. Always `--dry-run` first when the selector is broad — the preview names each session it would skip and why (already there, not a Claude Code session, its machine is offline). `--wait <minutes>` bounds how long a mid-turn session may finish before it is interrupted (default 10; 0 interrupts at once). A batch runs on the machine that holds the files and reports per session; `cast migrate show <batch>` is how you tell the human what moved.
<!-- cast @VERSION@ -->
<!-- /codecast-forks -->

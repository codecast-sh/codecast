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
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Triggers

You can set triggers — follow-up work that runs autonomously after this session ends. Use them for anything that should happen later: checking CI, reviewing PRs, continuing long-running refactors, or responding to events.

The prompt is the agent's entire briefing, and humans read it in the dashboard (rendered as markdown). A one-line prompt is fine for a one-line job; for anything bigger, write it as structured markdown — goal, numbered steps, constraints — never as one long run-on line. Pass `-` as the prompt to read it from stdin.

**Where a run happens.** A trigger created inside a session binds to that session by default: each run injects the prompt into it as a new turn, with the session's full history. Pass `--spawn` to start a FRESH session per run instead — no history, briefed only by your prompt, but still associated: the run's conversation links back to the trigger at the top in the UI. Use `--spawn` when the follow-up stands alone (a periodic audit, an independent check); write everything the agent needs into the prompt, since it arrives with none of your context. `--for <session>` binds a specific session from any shell.

```bash
# Set triggers (created in a session, these inject into it when they fire)
cast trigger add "Check if CI is green on main" --in 30m
cast trigger add "Respond to new PR review comments" --on pr_comment

# Fresh session per run — no history, linked back to the trigger
cast trigger add "Review open PRs and summarize findings" --every 4h --spawn
cast trigger add "Watch the funnel and report anything off" --every 4h --spawn --safe

# Multi-line prompts: heredoc via stdin
cast trigger add - --every 4h --title "Growth audit" <<'EOF'
Audit budget allocation across markets.

1. Verify the plan matches achievable yield.
2. Measure growth per dollar for markets funded in the last 14 days.

Escalate only strategic decisions to the founder.
EOF

# Report completion (when running inside a triggered run)
cast trigger complete tr-42 --summary "what was done"

# Manage triggers
cast trigger ls                       # list active triggers
cast trigger ls --all                 # include completed/failed
cast trigger update tr-42 --every 8h  # edit in place (--prompt/--title/--in/--every/--on); versioned + audited
cast trigger history tr-42            # edit history: every version, who changed what, from where
cast trigger pause tr-42              # pause a trigger
cast trigger run tr-42                # fire immediately
cast trigger cancel tr-42             # cancel a trigger
cast trigger log tr-42                # show last run conversation
```

Options:
- `--in <duration>`: delay before run (30m, 2h, 1d)
- `--every <duration>`: recurring interval
- `--on <event>`: fire on webhook (pr_comment, pr_opened, pr_merged, push)
- `--spawn`: fresh session per run, no history — linked back to the trigger in the UI
- `--for <session>`: bind runs to a specific session (defaults to the one you're in)
- `--safe`: read-only spawned run — write tools removed, state-changing commands blocked. Default is permissive: the run can act. A run injecting into an existing session inherits that session's rules.
- `--project <path>`: set working directory (defaults to current)
- `--max-runtime <duration>`: override max runtime (default: 10m)

Every trigger has a short ID (`tr-42`) — printed when you create one and listed by `cast trigger ls`. Use it for every command, and write it when you mention a trigger in prose; see "Referencing objects". When a trigger fires, its run receives your prompt and its short ID, and should call `cast trigger complete tr-42 --summary "..."` when done to report results back.
<!-- /codecast-tasks -->

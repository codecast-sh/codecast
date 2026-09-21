
## Triggers

You can set triggers — follow-up work that runs autonomously after this session ends. Use them for anything that should happen later: checking CI, reviewing PRs, continuing long-running refactors, or responding to events.

The prompt is the agent's entire briefing, and humans read it in the dashboard (rendered as markdown). A one-line prompt is fine for a one-line job; for anything bigger, write it as structured markdown — goal, numbered steps, constraints — never as one long run-on line. Pass `-` as the prompt to read it from stdin.

**Where a run happens.** Decide by what the run needs and where its result belongs. A follow-up that continues THIS work, needs what this conversation knows, and fires once or a few times belongs here: that is the default, each run arrives in this session as a new turn with the full history, and the result lands in the thread. A standing duty that repeats on a schedule (a monitor, a digest, a sweep) belongs in a fresh session per run: pass `--spawn`. An inline run reloads this session's whole history each time it fires, because the prompt cache has expired by then, and every firing grows the thread, so a repeating job run inline costs more each time and buries the conversation it lives in. A fresh run arrives with none of your context, so write everything it needs into the prompt; each run is handed the previous run's summary, which is the continuity most repeating jobs need.

Fresh runs stay out of the human's inbox: every `--spawn` run nests under the session that armed it and is read there, never as a loose card. What differs is where the result goes. A trigger that fires once is this session's worker: its result posts here as a message without waking you. A repeating trigger posts nothing on a clean run, because a line per firing would bury the thread; its summary is read under the trigger. Either way you are woken if a run fails, dies without reporting, or completes `--needs-attention`, so a finding is never buried in a run nobody reads. Add `--wake` when you must act on a clean report too, at the cost of a turn over this whole context. A run that hits a usage limit parks and resumes its own session at the window reset. `--thread` posts every run's result here; reserve it for results the human reads in this thread. `--for <session>` binds a specific session from any shell.

```bash
# Set triggers (created in a session, these inject into it when they fire)
cast trigger add "Check if CI is green on main" --in 30m
cast trigger add "Respond to new PR review comments" --on pr_comment

# Fresh session per run: a standing duty, briefed only by its prompt
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
- `--on <event>`: fire on webhook (pr_comment, pr_opened, pr_merged, push, issue_opened, issue_assigned, issue_labeled, issue_closed, issue_commented). The `issue_*` events cover Linear and GitHub alike: one trigger fires wherever the issue lives.
- `--spawn`: fresh session per run, no history; nested under the session that armed it, not a card in the inbox. Woken on a failure, a death or `--needs-attention`; a clean result posts back only for a trigger that fires once
- `--wake`: with `--spawn` on a once trigger, wake this session with a clean report too
- `--thread`: post each run's result into this conversation as a message
- `--for <session>`: bind runs to a specific session (defaults to the one you're in)
- `--safe`: read-only spawned run — write tools removed, state-changing commands blocked. Default is permissive: the run can act. A run injecting into an existing session inherits that session's rules.
- `--project <path>`: set working directory (defaults to current)
- `--max-runtime <duration>`: override max runtime (default: 10m)
- `--precheck <command>`: a shell gate run in the project directory before each scheduled or recurring firing. Exit 0 runs the trigger; anything else records a skipped run and spends no session. Reach for it when the trigger should act only if something changed ("has main moved?", "is the queue non-empty?") — otherwise a whole run is burned finding out the answer is no. Event triggers ignore it.

Every trigger has a short ID (`tr-42`) — printed when you create one and listed by `cast trigger ls`. Use it for every command, and write it when you mention a trigger in prose; see "Referencing objects". When a trigger fires, its run receives your prompt and its short ID, and should call `cast trigger complete tr-42 --summary "..."` when done. That completion is the run's declaration of who acts next: the summary is what the human reads on the trigger, so state the outcome. Add `--needs-attention` only when the human must read or act; it keeps the run in their inbox.
<!-- cast @VERSION@ -->
<!-- /codecast-tasks -->

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

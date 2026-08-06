A trigger is follow-up work that runs autonomously after the current session ends: check CI in thirty minutes, review PRs every four hours, respond when a review comment lands. The triggers snippet teaches agents to queue this work themselves — an agent finishes a PR and sets its own "check CI in 30m" trigger — so sessions stop needing a human to remember the follow-through.

Installed via [the snippet system](/documentation/agent-snippets):

```bash
cast trigger install
```

## Three ways to fire

```bash
cast trigger add "Check if CI is green on main" --in 30m        # once, after a delay
cast trigger add "Review open PRs and summarize" --every 4h     # recurring
cast trigger add "Respond to new review comments" --on pr_comment  # GitHub event
```

Event triggers need the GitHub integration and fire on `pr_comment`, `pr_opened`, `pr_merged`, or `push`.

## Where a run happens

A trigger created inside a session binds to that session by default: each run injects the prompt into it as a new turn, with the session's full history behind it. That is the right shape for follow-through on work the session already did.

`--spawn` starts a fresh session per run instead — no history, briefed only by the prompt, but still linked back to the trigger at the top of the run's conversation. Use it when the follow-up stands alone: a periodic audit, an independent check. Because a spawned run arrives with none of your context, the snippet insists the prompt carry everything: goal, numbered steps, constraints, written as structured markdown. Humans read these prompts in the dashboard, rendered as markdown, so a good brief serves both audiences. Pass `-` as the prompt to feed a heredoc.

`--for <session>` binds a specific session from any shell, and `--safe` makes a spawned run read-only — write tools removed, state-changing commands blocked. The default is permissive; a run injecting into an existing session inherits that session's rules either way.

## The trigger lifecycle

```bash
cast trigger ls              # active triggers, each with a short ID (tr-42)
cast trigger ls --all        # include completed and failed
cast trigger run tr-42       # fire immediately
cast trigger pause tr-42
cast trigger cancel tr-42
cast trigger log tr-42       # last run's conversation
```

Triggers are first-class in the inbox: they appear alongside sessions, each run links to the conversation it produced, and run history is browseable on every surface. Killing a session cancels its triggers; restoring the session re-arms them — so cleanup and resurrection stay symmetric.

When a run finishes, it reports back:

```bash
cast trigger complete tr-42 --summary "CI green; merged the backport"
```

The summary lands in the trigger's history, so the human scanning the dashboard sees outcomes, not just schedules.

## Judgment

The snippet's core instruction is restraint: set a trigger when there is a reason for one — a concrete follow-up, an event worth reacting to — not as a reflex. Recurring triggers with `--spawn --safe` make good standing watchers (funnels, error rates, open PRs); one-shot `--in` triggers make good follow-through on freshly shipped work.

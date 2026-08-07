Orchestration runs a whole plan across many agents at once. A conductor decomposes the goal into granular tasks with dependencies, spawns an implementer per ready task — each in its own isolated git worktree — then runs reviewers over completed work and critics over the integrated result. Humans watch waves of parallel work land instead of babysitting one session.

Two entry points share this machinery: the `cast plan` autopilot commands, and the `/orchestrate` skill the orchestration snippet installs.

## What the snippet installs

Unlike the other snippets, orchestration installs more than a markdown section. Via [the snippet system](/documentation/agent-snippets), `cast install orchestration` writes:

- an `/orchestrate` skill into `~/.claude/skills/` — the conductor's playbook,
- three agent definitions into `~/.claude/agents/` — **implementer** (does the work), **reviewer** (checks each task before merge), **critic** (sweeps the integrated result for issues),
- two lifecycle hooks in `~/.claude/settings.json` that fire only during orchestration runs.

Nothing activates on its own. Saying "orchestrate this plan" to an agent with the skill installed turns that agent into the conductor.

## The execution model

**Waves.** The conductor resolves the task dependency graph topologically. Every task whose dependencies are satisfied forms the current wave; the wave runs in parallel, one agent per task; completions unlock the next wave.

**Worktree isolation.** Each implementer works in its own git worktree on its own branch. Parallel agents never trample each other's files; completed branches merge back to main as their tasks pass review.

**Review before merge.** A reviewer agent checks each completed task against its acceptance criteria and returns a verdict — pass, needs changes, or reject. Failures route back to implementation with the review attached.

**Drive rounds.** After the graph completes, a critic reviews the integrated codebase. Issues it finds become fix tasks, which run as a new wave. Repeat until quality converges.

## Driving from the CLI

```bash
cast plan create "Build user dashboard" --goal "Activity feed, metrics, settings"
cast plan decompose pl-xxxx --depth deep    # Claude breaks the goal into 20–50 tasks
cast plan show pl-xxxx                      # review the task list before running
cast plan autopilot pl-xxxx                 # the main loop: waves until done
```

Autopilot options bound the blast radius: `--dry-run` shows what would spawn, `--max-agents 4` caps concurrency, `--max-waves 3` stops early, `--verify` typechecks before merging. While it runs:

```bash
cast plan agents pl-xxxx      # active agent sessions
cast plan wave pl-xxxx        # current and next wave
cast plan progress pl-xxxx    # ETA and breakdown by status
```

Failed tasks retry with escalation logging; a task that keeps failing is marked blocked and the run continues around it.

## Watching it

Every agent is a real session in the inbox, so the whole apparatus is observable with the ordinary tools: the dashboard groups workers under their plan, [`cast sessions --label`](/documentation/memory) watches a fleet live, and [messaging](/documentation/messaging) lets you — or the conductor — nudge any worker directly. Decisions made along the way land on the plan's timeline ([tasks and plans](/documentation/tasks-and-plans)), so the record of why survives the run.

Choose orchestration when the structure of the work is not known up front and a conductor should discover it. When the steps are known and must run the same way every time, write a [workflow](/documentation/workflows) instead.

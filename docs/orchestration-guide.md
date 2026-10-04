# Agent Orchestration System

A system for decomposing large features into hundreds of granular tasks, spawning parallel agents to implement them, and driving the work through validation and polish rounds -- autonomously.

## Core Concepts

**Plans** are containers for a large piece of work. A plan has a goal, a list of tasks, and state tracking (drive rounds, orchestration metadata, decisions, discoveries).

**Tasks** are atomic work items. Each task has a status (`open` -> `in_progress` -> `done`), priority, blocked_by dependencies, and execution metadata (retry count, agent session, heartbeat).

**Agents** are headless Claude Code runs (`claude -p`) started in the background, one per task. Each agent claims its task, implements it, tests it, and commits. Agents run in the directory you started the command from: there is no per-agent worktree, so start orchestration from a checkout nobody else is editing. Two agent types are spawned by the plan commands:
- **implementer** -- does the work
- **critic** -- finds issues during drive rounds

**Waves** are batches of tasks whose dependencies are all satisfied. The system resolves the task dependency graph topologically, spawns all ready tasks in parallel, waits for completion, then spawns the next wave.

**Drive rounds** are iterative polish loops. A critic agent reviews the codebase, finds issues, which become fix tasks. Repeat until quality converges.

## Quickstart: Run a Plan End-to-End

### 1. Create the plan

```bash
cast plan create "Build user dashboard" --goal "Full dashboard with activity feed, metrics, and settings"
# => pl-xxxx
```

### 2. Decompose into tasks

```bash
cast plan decompose pl-xxxx
```

This calls Claude to break the goal into granular tasks with dependencies. You'll be prompted to confirm before saving. `--depth` controls granularity (default `medium`):

```bash
cast plan decompose pl-xxxx --depth shallow   # 5-10 tasks
cast plan decompose pl-xxxx --depth medium    # 20-50 tasks
cast plan decompose pl-xxxx --depth deep      # 100+ tasks
```

### 3. Review the plan

```bash
cast plan show pl-xxxx          # full task list
cast plan wave pl-xxxx          # what's ready to run now
cast plan status pl-xxxx        # progress, blocked count, timing
```

### 4. Run autopilot

```bash
cast plan autopilot pl-xxxx
```

This is the main loop. It will:
1. Find all open tasks whose dependencies are done or dropped (the "wave")
2. Spawn an implementer agent per task, up to `--max` at once (default 3)
3. Check every `--interval` minutes (default 2) -- detect completions, failures, timeouts
4. When a task is done: commit a checkpoint of the working tree (`git add -A`, so anything else uncommitted in that checkout goes in too), and if a branch named `ashot/<task id>` exists, merge it and push main
5. Spawn the next wave
6. Repeat until all tasks are done

Options:
```bash
cast plan autopilot pl-xxxx --dry-run             # show what would spawn, don't actually do it
cast plan autopilot pl-xxxx --max 4               # limit concurrent agents
cast plan autopilot pl-xxxx --max-waves 3         # stop after N waves
cast plan autopilot pl-xxxx --verify              # run npx tsc --noEmit before merging
cast plan autopilot pl-xxxx --max-runtime 2h      # stop after this long
cast plan autopilot pl-xxxx --no-reschedule       # don't arm a resume trigger on exit
```

When autopilot exits with work left, it arms a trigger (`autopilot-resume:<plan>`) that runs it again in 5 minutes. Pass `--no-reschedule` to turn that off.

### 5. Monitor while it runs

```bash
# In another terminal:
cast plan agents pl-xxxx         # list active agent sessions
cast plan progress pl-xxxx       # ETA, breakdown by status
cast plan wave pl-xxxx           # current + next wave
```

Agent output is logged to `/tmp/codecast-agent-impl-ct-xxxx.log` (subprocess runtimes) or visible with `tmux attach -t impl-ct-xxxx` (tmux fallback).

### 6. Handle failures

Autopilot handles most failures automatically:
- **Agent dies** -- parses output for structured markers (BLOCKED, NEEDS_CONTEXT, DONE_WITH_CONCERNS), otherwise reopens the task and retries, up to 3 times (or the task's `max_retries`)
- **Agent times out** (30 minutes) -- kills and retries
- **Max retries exceeded** -- sets the task's execution status to `needs_context` and posts a blocker comment

For manual intervention:
```bash
cast plan retry pl-xxxx          # reset needs_context/blocked tasks back to open
cast plan kill pl-xxxx           # kill all agents
cast plan kill pl-xxxx --reset   # kill agents AND reset their tasks to open
```

### 7. Drive polish rounds

After the main implementation is done, run drive rounds to find issues:

```bash
cast plan drive pl-xxxx --rounds 3              # default 3
cast plan drive pl-xxxx --scope packages/web    # focus the critic on a directory or pattern
```

Each round:
1. Spawns a critic agent (Sonnet) over the scope, with a 5 minute cap
2. The critic writes structured findings (severity, `file:line`, suggested fix) to its log, `/tmp/codecast-agent-critic-pl-xxxx-rN.log`
3. The round is recorded on the plan's drive state

Drive does not turn findings into tasks or implement them. Read the critic's log, file fix tasks under the plan (`cast task create "…" --plan pl-xxxx`), and run autopilot again.

### 8. Verify and ship

```bash
cast plan verify pl-xxxx --all   # runs the repo's typecheck, test and lint scripts; exit 1 on failure
cast plan done pl-xxxx           # mark plan complete
```

## Manual Orchestration

If you want more control than autopilot, use the individual commands:

```bash
# Spawn agents for the current wave (--watch to monitor them after)
cast plan orchestrate pl-xxxx --max 3

# Watch them
cast plan agents pl-xxxx

# When done, merge their branches
cast plan merge pl-xxxx --dry-run   # preview
cast plan merge pl-xxxx             # actually merge

# Check for issues
cast plan verify pl-xxxx --typecheck

# Spawn next wave
cast plan orchestrate pl-xxxx --max 3
```

## Task Management

Tasks can be managed independently of plans:

```bash
# Create
cast task create "Fix auth redirect" -t bug -p high

# Work on it
cast task start ct-xxxx
cast task comment ct-xxxx "investigating the redirect flow" -t progress
cast task done ct-xxxx -m "Fixed by checking session before redirect"

# Dependencies
cast task dep ct-xxxx --blocked-by ct-yyyy

# View ready work
cast task ready
cast task context ct-xxxx     # full context for agents
```

### Task statuses
- `backlog` -- filed, not yet planned
- `open` -- not started
- `in_progress` -- someone/something is working on it
- `in_review` -- implementation done, awaiting review
- `done` -- complete
- `dropped` -- abandoned (doesn't block dependents)

Teams can define their own named statuses, but each one sits inside one of these six categories.

### Execution statuses
These track agent-level state within a task:
- `done` -- clean completion
- `done_with_concerns` -- completed but flagged issues
- `blocked` -- agent hit a blocker it can't resolve
- `needs_context` -- agent needs human input, or retries ran out

## Agent Runtime

The orchestration system auto-detects the best available agent runtime:

1. **Claude Code** (preferred) -- spawns `claude -p --permission-mode bypassPermissions` as a background subprocess. Output logged to `/tmp/codecast-agent-<name>.log`. No tmux required.
2. **Codex** -- spawns `codex exec` similarly. Used when `claude` isn't on PATH.
3. **tmux fallback** -- spawns Claude Code in a tmux session and pastes the prompt in. Used when neither `claude` nor `codex` is on PATH. Allows `tmux attach` for live observation.

The runtime is transparent -- `cast plan autopilot` picks the right one automatically. You can see which runtime is being used in the spawn log output.

## Agent Roles

Agent prompts are bundled into the CLI (`packages/cli/src/agents/prompts.ts`; no external config files needed).

### Implementer
The workhorse. Gets the plan and its task, implements, tests, commits. Runs on Opus unless the task names a model or the plan has a model stylesheet (`cast plan create --model-stylesheet`).

Key behaviors:
- Claims the task (`cast task start`)
- Reads the acceptance criteria; asks with NEEDS_CONTEXT if anything is unclear
- Implements in small commits with `Codecast-Plan` / `Codecast-Task` trailers
- Typechecks, runs related tests, reviews its own diff, screenshots user-facing changes
- Closes the task with `cast task done -m "…"` (does NOT merge -- autopilot handles that)
- On trouble, emits the structured markers below

### Critic
Finds issues during drive rounds. Analyzes the codebase within a given scope, looking for bugs, UX issues, missing features, code quality problems, performance issues, security gaps. Outputs structured findings with severity/location/fix. Uses Sonnet.

A reviewer prompt is also bundled, but no plan command spawns it today; review happens through the task's `in_review` status or a separate review session.

## Structured Agent Output

Agents can emit markers that autopilot parses:

- `DONE_WITH_CONCERNS: <detail>` -- task is done but has caveats
- `BLOCKED: <detail>` -- can't proceed, needs external help
- `NEEDS_CONTEXT: <detail>` -- missing information to continue

Autopilot reads the tail of each agent's log (or tmux pane) every check and acts on these markers: BLOCKED and NEEDS_CONTEXT set the task's execution status, post a blocker comment and stop the agent; DONE_WITH_CONCERNS marks the task done with the concern recorded.

## Web UI

The web app at codecast.sh provides visual management:

- **Plan detail panel** -- full task list with search/filter, inline title editing, priority cycling, status cycling, drive round indicators
- **Kanban board** (PlanBoardView) -- drag-and-drop tasks between Open / In Progress / Verify (`in_review`) / Done / Dropped columns
- **Slide-out panels** -- click any plan or task to see details in a side panel without leaving the current view

## Dependency Graph

The system includes graph algorithms for task scheduling:

- **Topological sort** -- determines valid execution order
- **Critical path** -- identifies the longest dependency chain (bottleneck)
- **Ready tasks** -- all open or backlog tasks whose blockers are all done/dropped
- **Dependency chain** -- full ancestor/descendant tree for any task

These power the wave batching in autopilot and the `cast plan wave` command.

## Tips

- Start with `--dry-run` on autopilot to preview what will happen
- Use `--max 2` or `--max 3` initially to keep things manageable
- Watch the first wave live (`tail -f /tmp/codecast-agent-impl-ct-xxxx.log`, or `tmux attach` on the fallback) to catch issues early
- If agents keep failing on a task, read their log and add context to the task description before retrying
- Drive rounds are most useful after the bulk implementation is done -- they catch integration issues and polish gaps
- The plan `status` command is your dashboard -- run it often
- Tasks marked `dropped` don't block dependents, so you can drop scope without breaking the graph

# Agent Orchestration System

A system for decomposing large features into hundreds of granular tasks, spawning parallel agents to implement them, and driving the work through validation and polish rounds -- autonomously.

## Core Concepts

**Plans** are containers for a large piece of work. A plan has a goal, a list of tasks, and state tracking (drive rounds, orchestration metadata, decisions, discoveries).

**Tasks** are atomic work items. Each task has a status (`open` -> `in_progress` -> `done`), priority, blocked_by dependencies, and execution metadata (retry count, agent session, heartbeat).

**Agents** are Claude sessions spawned in tmux. Each agent gets an isolated git worktree, picks up a task, implements it, tests it, and commits. Three agent types:
- **implementor** -- does the work
- **reviewer** -- reviews completed work before merge
- **critic** -- finds issues during drive/polish rounds

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

This calls Claude to break the goal into granular tasks with dependencies. You'll be prompted to confirm before saving. Use depth flags for control:

```bash
cast plan decompose pl-xxxx --depth deep     # 20-50 tasks
cast plan decompose pl-xxxx --depth extreme   # 100+ tasks
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
1. Find all tasks whose dependencies are met (the "wave")
2. Spawn an implementor agent per task in its own tmux session + git worktree
3. Poll every 30s -- detect completions, failures, timeouts
4. Merge completed branches to main
5. Spawn the next wave
6. Repeat until all tasks are done

Options:
```bash
cast plan autopilot pl-xxxx --dry-run        # show what would spawn, don't actually do it
cast plan autopilot pl-xxxx --max-agents 4   # limit concurrent agents
cast plan autopilot pl-xxxx --max-waves 3    # stop after N waves
cast plan autopilot pl-xxxx --verify         # typecheck before merging
```

### 5. Monitor while it runs

```bash
# In another terminal:
cast plan agents pl-xxxx         # list active agent sessions
cast plan progress pl-xxxx       # ETA, breakdown by status
cast plan wave pl-xxxx           # current + next wave
```

Agent output is logged to `/tmp/codecast-agent-impl-ct-xxxx.log` (for subprocess runtimes) or accessible via `tmux attach -t impl-ct-xxxx` (when using the tmux fallback).

### 6. Handle failures

Autopilot handles most failures automatically:
- **Agent dies** -- parses output for structured markers (BLOCKED, NEEDS_CONTEXT, DONE_WITH_CONCERNS), then auto-retries up to 3 times
- **Agent times out** (30min default) -- kills and retries
- **Max retries exceeded** -- marks task as needing human attention

For manual intervention:
```bash
cast plan retry pl-xxxx          # reset stuck tasks back to open
cast plan kill pl-xxxx           # kill all agents
cast plan kill pl-xxxx --reset   # kill agents AND reset their tasks to open
```

### 7. Drive polish rounds

After the main implementation is done, run drive rounds to find and fix issues:

```bash
cast plan drive pl-xxxx --rounds 3
```

Each round:
1. Spawns a critic agent to review the codebase
2. Critic outputs structured findings (severity, location, fix suggestion)
3. Findings become new fix tasks
4. Fix tasks are implemented
5. Next round

### 8. Verify and ship

```bash
cast plan verify pl-xxxx --all   # runs typecheck + tests + lint
cast plan done pl-xxxx           # mark plan complete
```

## Manual Orchestration

If you want more control than autopilot, use the individual commands:

```bash
# Spawn agents for the current wave
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
- `open` -- not started
- `in_progress` -- someone/something is working on it
- `in_review` -- implementation done, awaiting review
- `done` -- complete
- `dropped` -- abandoned (doesn't block dependents)
- `draft` -- not yet promoted to real work

### Execution statuses
These track agent-level state within a task:
- `running` -- agent is actively working
- `done` -- clean completion
- `done_with_concerns` -- completed but flagged issues
- `blocked` -- agent hit a blocker it can't resolve
- `needs_context` -- agent needs human input
- `failed` -- unrecoverable failure

## Agent Runtime

The orchestration system auto-detects the best available agent runtime:

1. **Claude Code** (preferred) -- spawns `claude -p` as a background subprocess. Output logged to `/tmp/codecast-agent-<name>.log`. No tmux required.
2. **Codex** -- spawns `codex exec` similarly. Used when Claude Code isn't available.
3. **tmux fallback** -- spawns Claude Code in a tmux session with interactive prompt pasting. Used when neither subprocess mode works. Allows `tmux attach` for live observation.

The runtime is transparent -- `cast plan autopilot` picks the right one automatically. You can see which runtime is being used in the spawn log output.

## Agent Roles

Agent prompts are bundled into the CLI (no external config files needed). Three roles:

### Implementor
The workhorse. Gets a task, creates a worktree, implements the feature, tests it, rebases onto main, commits. Uses Opus for maximum capability.

Key behaviors:
- Creates isolated worktree (`wt <task-id>`)
- Claims task (`cast task start`)
- Implements and tests (including visual verification via Chrome extension or simulator)
- Posts progress comments
- Rebases and commits (does NOT merge to main -- autopilot handles that)
- On failure, leaves structured blocker comments with `blocker_type`, `error_signature`, `approach`, `suggested_next`

### Reviewer
Reviews completed work. Gets the task context and branch diff, checks correctness, acceptance criteria, code quality, regressions, AI slop. Outputs PASS/FAIL with structured comments. Uses Sonnet for speed.

### Critic
Finds issues during drive rounds. Analyzes the codebase within a given scope, looking for bugs, UX issues, missing features, code quality problems, performance issues, security gaps. Outputs structured findings with severity/location/fix. Uses Sonnet.

## Structured Agent Output

Agents can emit markers that autopilot parses:

- `DONE_WITH_CONCERNS: <detail>` -- task is done but has caveats
- `BLOCKED: <detail>` -- can't proceed, needs external help
- `NEEDS_CONTEXT: <detail>` -- missing information to continue

Autopilot's `captureAgentOutput` / `parseAgentMarkers` functions read the last tmux output and act on these markers automatically.

## Web UI

The web app at codecast.sh provides visual management:

- **Plan detail panel** -- full task list with search/filter, inline title editing, priority cycling, status cycling, drive round indicators
- **Kanban board** (PlanBoardView) -- drag-and-drop tasks between Open/In Progress/Done/Dropped columns
- **Slide-out panels** -- click any plan or task to see details in a side panel without leaving the current view
- **Inbox sections** -- "Needs Attention" surfaces tasks requiring human input; "Draft Plans" shows plans not yet activated

## Dependency Graph

The system includes graph algorithms for task scheduling:

- **Topological sort** -- determines valid execution order
- **Critical path** -- identifies the longest dependency chain (bottleneck)
- **Ready tasks** -- all open tasks whose blockers are all done/dropped
- **Dependency chain** -- full ancestor/descendant tree for any task

These power the wave batching in autopilot and the `cast plan wave` command.

## Tips

- Start with `--dry-run` on autopilot to preview what will happen
- Use `--max-agents 2-3` initially to keep things manageable
- Watch the first wave live (`tmux attach`) to catch issues early
- If agents keep failing on a task, read their output (`agent-status.sh`) and add context to the task description before retrying
- Drive rounds are most useful after the bulk implementation is done -- they catch integration issues and polish gaps
- The plan `status` command is your dashboard -- run it often
- Tasks marked `dropped` don't block dependents, so you can drop scope without breaking the graph

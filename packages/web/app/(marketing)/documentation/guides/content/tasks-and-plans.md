The tasks snippet puts agents inside a structured work tracking system. Agents create tasks for real work, bind their sessions to them, log progress as comments, and mark work done with a summary of what they verified. A human monitors all of it through the dashboard — status flows through the system, not through chat messages that scroll away.

Installed via [the snippet system](/documentation/agent-snippets); it rides along with [memory](/documentation/memory) by default:

```bash
cast task install
```

## The objects

**Tasks** are work items (features, bugs, chores) with priorities, dependencies, and a status workflow: `backlog` → `open` → `in_progress` → `in_review` → `done`, with `dropped` for work that will not happen. A team can name its own statuses, but each one sits in one of these six. **Plans** group tasks under a goal and acceptance criteria for work with multiple distinct parts. **Docs** hold the prose — specs, investigations, handoffs. All three have short IDs (`ct-4102`, `pl-88`, `doc:…`) that render as live reference cards when written in prose anywhere in codecast.

![A plan's six tasks on the board](/documentation/shots/tasks.webp "A plan's tasks with their status, linked Linear issues, labels and owners, the plan's progress, and the activity on the open task.")

## The rules the snippet sets

The snippet is mostly judgment, not commands. Its rules:

- **Create a task** when the work will change code or produce a deliverable and will run long enough for someone to check on it. Skip it for questions, quick lookups, and small changes that finish in minutes.
- **Create a plan** only for work with multiple distinct parts. Single-task work gets a task.
- **Bind before you build.** `cast task start ct-4102` claims the task and binds the session to it; `cast plan bind pl-88` attaches to a plan. Sizable work done unbound is invisible to the human tracking it. A task has one owning session: starting a task another session is still working on is refused with that session's id so the two can coordinate, and `cast task start --take` moves ownership.
- **Check existing work first.** Search before creating: `cast task ls -q "auth"`, `cast plan ls -q "auth"`, `cast task ready` for unclaimed work. Claim rather than duplicate.
- **Escalate explicitly.** `BLOCKED: <reason>`, `NEEDS_CONTEXT: <what>`, and `DONE_WITH_CONCERNS: <concern>` are recognized markers that flag the session for human attention.

```figure
OwnershipFigure
One task, one owning session. A second start is refused with the owner's id until the two coordinate or the taker passes --take.
```

## The working loop

```bash
cast task start ct-4102                          # claim + bind the session
cast task comment ct-4102 "reproduced; fix in progress" -t progress
cast task done ct-4102 -m "fix + regression test, verified e2e"
```

```figure
TaskLifecycleFigure
Starting a task moves it to in progress and binds the session; comments log the work; done closes it with what was verified.
```

Plan-bound work adds coordination duties: record directional decisions with `cast plan comment pl-88 "decision" -d -r "rationale"`, flag dependencies, and suggest splitting tasks that grew too large. Decisions logged this way become part of the plan's permanent timeline, visible to every future session that binds to it.

## Context recovery

Long sessions get compacted. The snippet tells agents to reground from the system rather than trust compacted memory:

```bash
cast task context --current    # everything about the session's current task
cast plan context --current    # the plan: goal, tasks, decisions, discoveries
```

These print the full work item — description, comments, linked sessions — so a compacted agent recovers exactly the state it needs.

```figure
ContextRecoveryFigure
Compaction keeps a summary and loses the specifics; the task record still holds them.
```

## Where this leads

Tasks and plans are the substrate for the heavier machinery: [workflows](/documentation/workflows) bind execution graphs to them, and [orchestration](/documentation/orchestration) decomposes a plan into tasks and runs them in parallel across agents. [Triggers](/documentation/triggers) handle the time dimension — work that should happen after the session ends.

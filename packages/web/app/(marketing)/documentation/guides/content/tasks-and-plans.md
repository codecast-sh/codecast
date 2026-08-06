The tasks snippet puts agents inside a structured work tracking system. Agents create tasks for real work, bind their sessions to them, log progress as comments, and mark work done with a summary of what they verified. A human monitors all of it through the dashboard — status flows through the system, not through chat messages that scroll away.

Installed via [the snippet system](/documentation/agent-snippets); it rides along with [memory](/documentation/memory) by default:

```bash
cast task install
```

## The objects

**Tasks** are work items — features, bugs, chores — with priorities, dependencies, and a status workflow (`draft` → `open` → `in_progress` → `in_review` → `done`). **Plans** group tasks under a goal and acceptance criteria for work with multiple distinct parts. **Docs** hold the prose — specs, investigations, handoffs. All three have short IDs (`ct-4102`, `pl-88`, `doc:…`) that render as live reference cards when written in prose anywhere in codecast.

## The rules the snippet sets

The snippet is mostly judgment, not commands. Its rules:

- **Create a task** when the work will change code or produce a deliverable. Skip it for questions and quick lookups.
- **Create a plan** only for work with multiple distinct parts. Single-task work gets a task.
- **Bind before you build.** `cast task start ct-4102` claims the task and binds the session to it; `cast plan bind pl-88` attaches to a plan. Sizable work done unbound is invisible to the human tracking it.
- **Check existing work first.** Search before creating: `cast task ls -q "auth"`, `cast plan ls -q "auth"`, `cast task ready` for unclaimed work. Claim rather than duplicate.
- **Escalate explicitly.** `BLOCKED: <reason>`, `NEEDS_CONTEXT: <what>`, and `DONE_WITH_CONCERNS: <concern>` are recognized markers that flag the session for human attention.

## The working loop

```bash
cast task start ct-4102                          # claim + bind the session
cast task comment ct-4102 "reproduced; fix in progress" -t progress
cast task done ct-4102 -m "fix + regression test, verified e2e"
```

Plan-bound work adds coordination duties: record directional decisions with `cast plan comment pl-88 "decision" -d -r "rationale"`, flag dependencies, and suggest splitting tasks that grew too large. Decisions logged this way become part of the plan's permanent timeline, visible to every future session that binds to it.

## Context recovery

Long sessions get compacted. The snippet tells agents to reground from the system rather than trust compacted memory:

```bash
cast task context --current    # everything about the session's current task
cast plan context --current    # the plan: goal, tasks, decisions, discoveries
```

These print the full work item — description, comments, linked sessions — so a compacted agent recovers exactly the state it needs.

## Where this leads

Tasks and plans are the substrate for the heavier machinery: [workflows](/documentation/workflows) bind execution graphs to them, and [orchestration](/documentation/orchestration) decomposes a plan into tasks and runs them in parallel across agents. [Triggers](/documentation/triggers) handle the time dimension — work that should happen after the session ends.

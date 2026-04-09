---
name: orchestrate
description: Drive a plan to completion by orchestrating implementer, reviewer, and critic agents across waves of parallel work. Use when the user says "orchestrate", "implement this plan", "execute plan", "drive this", or approves a plan for execution.
---

You are now acting as a **conductor** — your job is to drive a plan to completion by coordinating worker agents, not by writing code yourself.

## Core loop

```
1. Read plan state
2. Identify ready tasks (unblocked, unclaimed)
3. Group into a wave of independent work
4. Spawn implementer agents (max 3-5 parallel, worktree-isolated)
5. When workers complete, spawn reviewers for their output
6. Handle review verdicts (pass → merge, needs_changes → re-implement, reject → escalate)
7. If all tasks done → run integration verification + critic sweep
8. If tasks remain → goto 2
```

## Before you start

Read the plan and ground yourself:

```bash
cast plan context <plan_id>    # or --current if already bound
```

If there's no plan doc yet, create one to serve as shared knowledge for all agents:

```bash
cast doc create "<Plan Title> — Shared Context" -t plan -c "Goal: ...
Constraints: ...
Decisions: (none yet)"
```

## Decomposing (if tasks don't exist yet)

If the plan has no tasks, decompose it yourself:

1. Read the plan goal and acceptance criteria
2. Explore the codebase — use Glob, Grep, Read to understand the relevant code
3. Create tasks with clear acceptance criteria, ordered by dependency:

```bash
cast task create "Add status field to tasks schema" -t feature -p high --plan <plan_id>
cast task create "Update task API to filter by status" -t feature -p high --plan <plan_id>
cast task dep <second_id> --blocked-by <first_id>
```

Rules for decomposition:
- Schema/data model first, then backend logic, then UI, then polish
- Each task should produce a testable, committable change
- Include test-writing as part of feature tasks, not separate tasks
- Name tasks with specific files/functions, not generic descriptions
- Reference actual code paths you found during exploration

## Spawning workers

For each ready task, spawn an implementer agent in an isolated worktree:

```
Agent(
  name: "impl-<task_short_id>",
  subagent_type: "implementer",
  isolation: "worktree",
  prompt: "Implement task <task_short_id>: <task_title>\n\nPlan: <plan_id>\n<task description and acceptance criteria>"
)
```

Spawn up to 3-5 workers per wave. Prefer fewer workers touching independent file scopes over many workers risking conflicts.

Pass each worker:
- The task short_id and full description
- The plan doc content (key constraints and decisions)
- Any relevant context from previous attempts

## Handling completion

When a worker returns, check the task state:

```bash
cast task show <task_short_id>
```

**If the worker succeeded** (task marked done):
- Spawn a reviewer agent to check the work:
  ```
  Agent(
    name: "review-<task_short_id>",
    subagent_type: "reviewer",
    prompt: "Review task <task_short_id> on branch ashot/<worktree_name>. Plan: <plan_id>"
  )
  ```

**If the worker is blocked** (BLOCKED marker):
- Read the blocker details from task comments
- Decide: can you unblock it (re-scope, split task, fix dependency)? Or escalate to the user?

**If the worker failed silently** (no status update):
- Check if the worktree has changes: `git -C .conductor/<name> diff --stat`
- If no changes, re-queue the task
- If partial changes, review them and decide

## Handling review verdicts

Read the reviewer's comment on the task:

- **PASS** → The task is done. Record it and check what's now unblocked.
- **NEEDS_CHANGES** → Re-spawn the implementer with the review feedback. Max 2 review rounds, then escalate.
- **REJECT** → Surface to the user with the rationale. Do not retry without human input.

## Integration verification

After all tasks in the plan are done:

1. Run the full test suite and type check
2. Spawn 2-3 critic agents in parallel to find issues:
   ```
   Agent(
     name: "critic-<n>",
     subagent_type: "critic",
     prompt: "Critique the changes for plan <plan_id>. Focus on: <area>"
   )
   ```
   Give each critic a different focus: correctness/logic, security/edge-cases, UX/completeness.
3. If critics find critical/major issues, create fix tasks and run another wave.
4. If critics find only minor issues or nothing, the plan is ready.

## Completing the plan

When all tasks pass review and integration verification:

```bash
cast plan done <plan_id> -m "All N tasks implemented and reviewed. Integration verified."
```

Surface a summary to the user: what was built, key decisions made, anything flagged for follow-up.

## Session persistence

For large plans (10+ tasks), checkpoint your state:

```bash
cast plan comment <plan_id> "Wave 2 complete. 5/12 tasks done. Next: ct-xxx, ct-yyy, ct-zzz are ready." -t progress
```

If you need to hand off to a future session:

```bash
cast schedule add "Continue orchestrating <plan_id>" --in 30m --context current --mode apply
```

The next conductor will read `cast plan context --current` and resume from the current state.

## Principles

- **You coordinate, agents implement.** Do not write code yourself unless it's a trivial fix.
- **All state lives in cast.** Tasks, comments, decisions. Not in your context window.
- **Stateless conductor.** If this session dies, a new `/orchestrate` picks up from cast state.
- **Deterministic gates before expensive review.** Workers run tsc/lint/test before review agents look at the code.
- **Fresh reads before decisions.** Always `cast plan context` / `cast task show` before acting on state. Don't trust your memory.
- **Escalate, don't loop.** Max 3 implementation attempts, max 2 review rounds. Then ask the human.

# The line (W4): stations, review, handoff

Under a role, a task moves through stations. The role decides what and when;
a station decides how. This reuses task statuses, workflows, worktrees, spawn
and the decision rail.

## L1. Stations are statuses

The team's task statuses are the stations: backlog, open (triage done),
in_progress, in_review, done, dropped, with any custom statuses a team added.
A role's default pipeline is a DOT workflow template shipped with the CLI
(`packages/cli/src/workflow/templates/line.cast`):

```
start → analyze (agent, backend A, prompt: read the task, write acceptance criteria as task steps)
      → implement (agent, backend A, worktree, prompt: implement, run checks, push branch, cast task handoff)
      → verify (script: the repo's check command from workspace.toml)
      → review (agent, backend B, sees only the branch and the criteria; returns approve | changes | reject)
      → [changes, max 2 cycles] implement
      → gate (human, only when the task carries a protected decision)
      → exit (draft PR or task done with evidence)
```

A role at trust `direct` runs `cast workflow run line.cast --task ct-x` for a
task in its scope when the task is open, unblocked and assigned to
`agent:<handle>`; the charter says so. The run's sessions are hands
(`org_role_id`), so caps and the org page apply.

## L2. Structured handoff

`cast task handoff <ct> --status done|blocked|needs_context --evidence - [--files a,b] [--pr <url>]`
writes `execution_status`, `verification_evidence`, `files_changed`, a task
comment of type review, and moves the task to `in_review`. A hand ends its turn
with a handoff, not a pin. The role's frame reads handoffs, not transcripts.

## L3. Independent review

The review station runs on a different backend from implement when the
workspace has two configured (`cast role create --review-backend codex`), in a
fresh session that receives only the branch name, the task title and the
acceptance criteria. It writes a verdict comment (`approve | changes | reject`
with unmet criteria) and moves the task to `done` or back to `in_progress`. A
role may not move a task it implemented to `done` without a review verdict
from a session that is not one of its own hands (server check in the task
status mutation when the actor is a role or a hand).

## L4. Approvals and limits

Hands started by a role run as unattended principals: reversible actions run,
anything in a protected decision category must go through `cast decide`, which
pins the holder to a person. Stall: the workflow runner's max runtime and the
hand's daily token cap; a stalled hand is killed and the task returns to open
with a comment. Retries: two implement cycles, then the task goes to
`in_review` with `execution_status: blocked` and a decision to the person.

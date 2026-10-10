# One Ship control

One standard way to land a change, pressed from three places: a task in review,
a pull request page, and a line run's
change card. `cast ship run` is the same press from a terminal. Every press
reaches one server action, `startShipCore` in `packages/convex/convex/ship.ts`.

## What a press does

`gatherShipFacts` reads the target and what it touches: the task, the session
doing the work (the task's newest linked session on a branch, the session
itself, or the PR's shepherd), the pull request already open from that
session, the project's published line profile, and, for a task, a line run
parked at its change card. `resolveShipPlan`
(`packages/shared/contracts/shipPlan.ts`) turns those facts into the plan. The
popover renders that plan, `cast ship run --dry-run` prints it, and the press
runs it, so all three say the same thing.

| Procedure | When | What runs |
|---|---|---|
| `line_gate` | a task whose line run waits at its change card | Ship answers the card; the line's ship station runs the profile's `ship` command, or, when there is none, `cast ship run --task` (the `cast_ship` flow below) |
| `profile_command` | the project's profile has `commands.ship` | a ship session runs the profile's check, then the ship command |
| `cast_ship` | anything else | a ship session runs the check, then the cast-ship skill: commit, push, open the PR, shepherd it |

The ship session is spawned through `spawnSessionCore`, nested under the work's
session, else under the session that asked (`shipParent`: a worker counts, and
a stashed, dismissed or killed one hands the run to its nearest live ancestor;
top level only when none is left), linked to the task, and stamped
`ship_target_key`. Its first turn is `shipBrief`: the branch, the task, the
checks, the PR to open or shepherd, and whether to merge. A change sitting on
the base branch moves to `ship/<task or session>` in a worktree first.

## Merging

Ship never merges unless one of these holds, and the popover says which:

- it was pressed on the pull request page,
- the project's profile sets `[line.merge] auto = true`, or
- the task is on a role's line and that role holds a merge grant
  (`org_roles.line_merge`, the-line.md L12); the ship session then merges
  through `cast line merge`, which counts it against the role's daily limit.

A task or session press opens the PR and shepherds it, and so does a change
card's Ship on a project with no ship command. `[line.merge] method` picks
squash (default), merge or rebase.

## Progress

`ship_runs` records every press (target, plan, the ship session or the card it
answered). `ship.forTarget` feeds one `shipTargets` store row per target: the
plan a press would run now, the latest run, and for a card answer the line
run's ship station. The control reads the ship session's row
(`sessions`, its pinned `cast state` and `pr_status`) and its PR's checks
(`pullRequests`) from the store, and `shipProgress` folds them into one phase:
starting, working, checks running, PR open, merged, failed (naming the failing
check), or done.

## Where it renders

Ship is a team feature (`teams.features.ship`, off by default, toggled in
team settings). In an off workspace none of the controls below render; the
personal workspace follows the viewer's teams.

- Task page: `TaskShipStation`, at the review station (status in review, or
  any task with a ship run).
- PR page: beside the merge menu, for an open PR.
- Change card: its Ship verdict calls the store's `startShip` with the card,
  which answers the card on the decision rail and records the run.

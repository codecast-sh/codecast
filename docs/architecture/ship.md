# One Ship control

One standard way to land a change, pressed from four places: a task in review,
a session page with changes on a branch, a pull request page, and a line run's
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
| `line_gate` | a task whose line run waits at its change card | Ship answers the card; the line's ship station runs the profile's `ship` command, or its merge step when there is none (line-profile.md LP4) |
| `profile_command` | the project's profile has `commands.ship` | a ship session runs the profile's check, then the ship command |
| `cast_ship` | anything else | a ship session runs the check, then the cast-ship skill: commit, push, open the PR, shepherd it |

The ship session is spawned through `spawnSessionCore`, nested under the work's
session while that is still in the person's inbox (else under the CLI caller's
session, else top level), linked to the task, and stamped
`ship_target_key`. Its first turn is `shipBrief`: the branch, the task, the
checks, the PR to open or shepherd, and whether to merge. A change sitting on
the base branch moves to `ship/<task or session>` in a worktree first.

## Merging

Ship never merges unless one of these holds, and the popover says which:

- it was pressed on the pull request page, or
- the project's profile sets `[line.merge] auto = true`.

A task or session press opens the PR and shepherds it. `[line.merge] method`
picks squash (default), merge or rebase. A `line_gate` press lands the change
the line's way, which merges when the project has no ship command.

## Progress

`ship_runs` records every press (target, plan, the ship session or the card it
answered). `ship.forTarget` feeds one `shipTargets` store row per target: the
plan a press would run now, the latest run, and for a card answer the line
run's ship and merge stations. The control reads the ship session's row
(`sessions`, its pinned `cast state` and `pr_status`) and its PR's checks
(`pullRequests`) from the store, and `shipProgress` folds them into one phase:
starting, working, checks running, PR open, merged, failed (naming the failing
check), or done.

## Where it renders

- Task page: `TaskShipStation`, at the review station (status in review, or
  any task with a ship run).
- Session header: `SessionShipButton`, when the session has a branch with
  uncommitted changes or commits ahead, and is not itself a ship session.
- PR page: beside the merge menu, for an open PR.
- Change card: its Ship verdict calls the store's `startShip` with the card,
  which answers the card on the decision rail and records the run.

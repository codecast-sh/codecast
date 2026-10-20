# Deploys: a stage of the line and an object of their own

A problem's run on the line ends at Ship, which merges its fix. Merging is not
going live: a team deploys on its own clock, and one deploy usually carries
several fixes. This document makes that last step part of the line, and makes
each deploy an object people can open, cite and read charts by. Sections are
DP1 onward so code can cite them.

## DP1. A deploy is an object

`deploys` (convex), one row per version that went live, or was asked to, on
one target. Short id `dp-N`.

| Field | What it holds |
|---|---|
| `target` | the surface or environment it went to: `backend`, `production` |
| `status` | `requested` (asked for, no machine has started it), `running`, `live`, `failed`, `cancelled` |
| `trigger` | `person` (Deploy on the Line page, `cast line deploy --go`), `role` / `schedule` / `count` (reserved, DP4), `outside` (the team's own path, recorded from its marker) |
| `started_by` | who or what started it: a person, the CLI, a source |
| `source` | who reported it: `cast ship mark`, a source's name, `line` |
| `sha`, `previous_sha`, `version`, `url`, `commits` | what went out, when the reporter knows |
| `carries` | the fixes it carried: problem, run, the card that shipped it, the merge, and how it is known (`sent`, `same commit`, `deployed after the merge`) |
| `event_ids` | the markers that reported it |

A deploy marker stays an `external_events` row of kind `deploy` (the team's
event stream, triggers, the Changes page); its `meta.deploy` names the deploy
object. `deploys.recordDeployMarker` is the one writer from a marker, called by
`changesDeploy.markDeploy` (`cast ship mark`) and by ingest's deploy items. In
order it:

1. enriches the deploy this marker already recorded (same target and sha, or
   version): a second report adds the run's url, the commit range;
2. finishes the line's open deploy on the same target asked for within a day
   (live, with the sha);
3. otherwise records a deploy of its own (`trigger: outside`) carrying the
   fixes the history's rule says it carried: the first live deploy on its
   target at or after a merge, on the same code (`causeHistory
   carryingDeploys`, the same rule a problem's timeline reads).

A deploy recorded from a marker names no project: it ships the code, and one
repository holds every project of a team like Union, so it carries the fixes
of every project in its workspace and shows on each of their lines. A deploy
the line's stage sends names the project it was asked from, and gathers the
fixes of every project whose line publishes from the same checkout.

A marker that names a place no user reaches (`local`, `dev`, `staging` and the
like, `deployIsLive`) records no deploy. An ingest deploy item may carry
`url`, `actor`, `previous_sha` and `commits` besides its version and sha.

## DP2. The deploy stage

The line's last stage is not per problem. It gathers the project's shipped
fixes that no live deploy has carried and sends them out together, through the team's own
deploy path, as one deploy.

- The path is the profile's `[line.deploy]` (line-profile.md):
  `command` (run from the repository root; `$sha`, `$deploy` and `$actor`
  expand, and `CAST_DEPLOY_SHA`, `CAST_DEPLOY_ID`, `CAST_DEPLOY_ACTOR` are
  set), `target` (what its markers name, so a marker finds the deploy it
  finishes), `trigger`. No command, no stage: the line stops at Ship.
- `deploys.stage` reads the waiting fixes and the deploy already going out.
  `deploys.request` (and `requestDeployCore`, which the web's `deployLine`
  dispatch rides) writes one `requested` deploy whose `carries` are the
  waiting fixes (`how: sent`), refusing while another is going out or nothing
  waits.
- From the web, the request queues `line_deploy` on the machine that publishes
  the profile, which runs `cast line deploy run dp-N` in that checkout. From a
  terminal, `cast line deploy` shows the stage and `--go` asks and runs here.
- `lineDeploy.runDeploy` reports `running` (with the sha of the default
  branch's head on origin), runs the command with no model or cloud keys in
  its environment, then reports `live` or `failed` with the output's tail. A
  GitHub Actions run url the path prints becomes the deploy's url. A marker
  from the path itself may finish the deploy first; a report never moves a
  deploy backwards.

## DP3. Which deploy carried a fix

A fix's merge is either a line run's merge step (`workflow_runs.merge`, read
through `by_workspace_merged`) or the problem's commit landing on its default
branch outside that step (`tasks.landed`, through `by_workspace_landed`),
which is how most fixes reach Union's main. The web's history also reads a
fix branch's pull request merged by hand; the Deploys view joins what the
server recorded with what each problem's history says (`deploysView
carriesOf`), so a deploy and a problem's timeline never disagree.

Two answers, one rule. A deploy the stage sent carries what was waiting when it
was asked for. A deploy recorded from a marker carries, by the history's rule,
every merge it is the first live deploy after. A problem's timeline, its
band's "In production" and the deploy's own page all read the same rows.

## DP4. What starts the stage

Today only a person: the Deploy button on the Line page's Deploys view, or
`cast line deploy --go`. That is how Union deploys now (merging to main never
deploys; a person presses Deploy on the admin page or runs
`outreach/deploy.sh`). `[line.deploy] trigger` already accepts `role`,
`schedule` and `count`, so the other triggers slot in without a schema
change; which one a line uses is a person's choice.

A profile key a CLI does not know stops every line run that CLI loads the
profile for (`lineProfile.ts` refuses unknown keys), so a `[line.deploy]`
table goes into a repository's profile only once every machine that runs its
line has a CLI that reads it.

## DP5. What happened after

Derived at read, never stored. A live deploy's window runs from when it went
live to the next live deploy on its target, else to now (at most 14 days). In
it: each carried problem's findings and whether one reopened it; the error
groups of its source (or workspace) that started (`first_seen`) or came back
(`regressed_at`). `quiet` when nothing came back and no error started.

## DP6. Backfill

`deploys:backfill` records every deploy marker already in `external_events`
as a deploy object, oldest first, one source or repository per call, paged by
`since`/`next`; a marker whose `meta.deploy` is set is skipped, so a rerun
writes nothing. `deploys:backfillTargets` lists the sources and repositories
to walk. `deploys:recarry` recomputes the carries of deploys recorded from
markers, ten per call, after the merges the rule reads change. Run them
through `packages/convex/run.sh`.

## DP7. Where deploys show

- `dp-N` is a reference everywhere (entity type `deploy`): a pill with its
  state, opening `/line?view=deploys&deploy=dp-N`.
- The Line app's Deploys view: what waits to go out per project with its
  Deploy press (through the shared confirm flow), every deploy with its state,
  findings per day with each deploy marked (the picked deploy's carried
  problems drawn on their own), and one deploy whole: when, who, what it
  carried with each problem's findings the week before and after, errors in
  its window, commits.
- A problem's timeline: a deploy flag opens its deploy; the band's
  "In production" names it.
- A decision page: a line card answered Ship says which deploy it went out in.
- The Changes page's live strip and the Ops timeline: a deploy opens its
  deploy object.

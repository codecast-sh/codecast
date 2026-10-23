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
| `trigger` | `person` (Deploy on the Line page, `cast line deploy --go`), `role` (the profile's role, DP4), `schedule` / `count` (reserved), `outside` (the team's own path, recorded from its marker) |
| `started_by` | who or what started it: a person, the CLI, a source |
| `source` | who reported it: `cast ship mark`, a source's name, `line` |
| `sha`, `previous_sha`, `version`, `url`, `commits` | what went out, when the reporter knows |
| `carries` | the fixes it carried: problem, run, the card that shipped it, the merge, and how it is known (`sent`, `same commit`, `deployed after the merge`) |
| `event_ids` | the markers that reported it |
| `run_id` | the line-deploy run that carries it through its steps (DP8); each step's state is that run's station, read from the run |

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

- The path is the profile's `[line.deploy]` (line-profile.md LP2):
  `command` (the send step, run from the repository root; `$sha`, `$deploy`
  and `$actor` expand, and `CAST_DEPLOY_SHA`, `CAST_DEPLOY_ID`,
  `CAST_DEPLOY_ACTOR` and, once the send named one, `CAST_DEPLOY_URL` are
  set), `target` (what its markers name, so a marker finds the deploy it
  finishes), `trigger` and `role` (DP4), and a command for each other step
  (`ci`, `gate`, `rollout`, `live`, DP8). No command, no stage: the line
  stops at Ship. The role and step keys ride the published profile only when
  set, so a profile that names none publishes the shape an older backend
  accepts.
- `deploys.stage` reads the waiting fixes and the deploy already going out.
  `deploys.request` (and `requestDeployCore`, which the web's `deployLine`
  dispatch rides) writes one `requested` deploy whose `carries` are the
  waiting fixes (`how: sent`), refusing while another is going out or nothing
  waits.
- From the web, or from the role (DP4), the request queues `line_deploy` on
  the machine that publishes the profile, which runs `cast line deploy run
  dp-N` in that checkout (the daemon gives it ten hours: CI and an eval gate
  take hours). From a terminal, `cast line deploy` shows the stage and `--go`
  asks and runs here.
- Either way the deploy's steps run as the stations of the line-deploy
  graph (DP8). The first step reports `running` with the sha of the default
  branch's head on origin and the run's id; every later step reads that sha
  back. Steps run with no model or cloud keys in their environment. A GitHub
  Actions run url the send prints becomes the deploy's url. The watch
  station reports `live`; Returned reports `failed` with the step's words
  (DP9). A marker from the path itself may finish the deploy first; a report
  never moves a deploy backwards.

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

Two things start it, side by side.

- **A person**: the Deploy button on the Line page's Deploys view (through
  the shared confirm flow), or `cast line deploy --go`. Always available,
  whatever the trigger, and counted against nothing.
- **The line's role**, when the profile says `trigger = "role"` and
  `role = "<handle>"` (Union's Release Captain, `@release`). Every ten minutes
  `deploys.autoDeploy` (crons.ts) reads the roles that hold a live deploy
  grant and their teams' projects whose profile names them. For each, the
  role asks for a deploy (`trigger: role`, `started_by` the role) when fixes
  wait, nothing is going out, the newest waiting fix merged at least 30
  minutes ago (`DEPLOY_SETTLE_MS`, so a burst of merges goes out as one
  deploy), and the line's last deploy did not fail on the same fixes (after a
  failure the role waits for a newer fix, or a person presses Deploy, so a
  red gate cannot spend the day's limit retrying). The ask increments the
  role's `counters.deploys` and tells the role one line in its standing
  session. It runs on the machine that publishes the profile, as that
  profile's publisher.

What lets the role deploy is a person's act: the role's `deploy` authority
grant (org-hire.md H4: id `deploy`, kind `publish`, a `per_day` limit and an
expiry), written through `cast role authority` or the role page like any
grant, human only. `deployAllowance` (shared/contracts/lineDeploy.ts) reads
it from the role row alone: the role active and starting work on its own,
the grant live, a daily limit set, and room under it today. A grant with no
`per_day` allows nothing. The trigger, the stage (`deploys.stage` returns
`auto`: the role, whether it may deploy now, why not, today's count) and the
Deploys view all read this one answer. Revoking the grant stops the role;
the button stays.

The eval gate is the team's, not codecast's: Union's runs inside its own
deploy path (deploy.yml's `gate` and `evals` jobs, on the deploy sha, with
production's secrets), and the line's Gate station reads its verdict (DP8).
A role never skips it: the role's send is the profile's command as written.

A profile key a CLI does not know stops every line run that CLI loads the
profile for (`lineProfile.ts` refuses unknown keys), so a `[line.deploy]`
table goes into a repository's profile only once every machine that runs its
line has a CLI that reads it, and the role and step keys only once that CLI
has them too.

## DP5. What happened after

Derived at read, never stored. A live deploy's window runs from when it went
live to the next live deploy on its target, else to now (at most 14 days). In
it: each carried problem's findings and whether one reopened it; the error
groups of its source (or workspace) that started (`first_seen`) or came back
(`regressed_at`). `quiet` when nothing came back and no error started.

## DP6. Backfill

`deploysBackfill:backfill` records every deploy marker already in `external_events`
as a deploy object, oldest first, one source or repository per call, paged by
`since`/`next`; a marker whose `meta.deploy` is set is skipped, so a rerun
writes nothing. `deploysBackfill:backfillTargets` lists the sources and repositories
to walk. `deploysBackfill:recarry` recomputes the carries of deploys recorded from
markers, ten per call, after the merges the rule reads change. Run them
through `packages/convex/run.sh`.

## DP7. Where deploys show

- `dp-N` is a reference everywhere (entity type `deploy`): a pill with its
  state, opening `/flows?view=deploys&deploy=dp-N`.
- The Line app's Deploys view: what waits to go out per project with its
  Deploy press (through the shared confirm flow) and, on a role-trigger line,
  the role that sends it with today's deploys against its limit or why it
  waits, on a link to the role; every deploy with its state,
  findings per day with each deploy marked (the picked deploy's carried
  problems drawn on their own), and one deploy whole: when, who, its steps
  as its run's stations stand (DP8), what it carried with each problem's
  findings the week before and after, errors in its window, commits.
- A problem's timeline: a deploy flag opens its deploy; the band's
  "In production" names it.
- A decision page: a line card answered Ship says which deploy it went out in.
- The Changes page's live strip and the Ops timeline: a deploy opens its
  deploy object.

## DP8. A deploy's steps are stations

A deploy runs on the shipped `line-deploy` graph
(cli workflow/templates/line-deploy.cast), a workflow run of its own with
the deploy (dp-N) as its goal, so the runner keeps each step's state, its
timeout and its resume, and the deploy's page shows them.

| Station | Runs | When it is left out |
|---|---|---|
| CI | `[line.deploy] ci`, before anything goes out | passes with a note |
| Send | `[line.deploy] command`, the team's deploy path | (the stage needs it) |
| Gate | `[line.deploy] gate`, the eval gate's verdict | passes with a note |
| Roll out | `[line.deploy] rollout` | passes with a note |
| Live | `[line.deploy] live`, production answering with `$sha` | passes with a note |
| Watch | `cast line deploy watch`: the deploy is live, and every carried fix that shipped is watched for the profile's `watch_days` from now, never shortened (LE12) | |

Each step station is `cast line deploy step <step> dp-N`. A team whose path
does everything in one command names only `command`, and the graph is the
old stage. A team whose path is one CI run with its own jobs (Union's
deploy.yml: `ci-verdict`, `gate`, `evals`, `deploy`) sends it without waiting
(`deploy.sh --no-watch`) and names helpers for the steps after:

- `cast line deploy ci [--workflow ci.yml]` waits for CI's verdict on the
  deploy sha: the named workflow's newest finished run on the commit (a rerun
  in flight waits), or with none named, every check run on it.
- `cast line deploy follow --jobs gate,evals` waits for those jobs of the run
  the send named (`CAST_DEPLOY_URL`) and passes when every one succeeded; a
  failed, cancelled or skipped job fails the step with its failed log's tail.

Union's profile, when its machines can read it:

```toml
[line.deploy]
command = "outreach/deploy.sh --sha $sha --actor $actor --no-watch"
target = "production"
trigger = "role"
role = "release"
ci = "cast line deploy ci --workflow ci.yml"
gate = "cast line deploy follow --jobs gate,evals"
rollout = "cast line deploy follow --jobs deploy"
live = "live=$(curl -sf --max-time 10 https://outreach-api.fly.dev/health | jq -r '.gitSha // empty'); if [ -n \"$live\" ] && case $sha in \"$live\"*) true;; *) false;; esac; then echo production runs $live; else echo production runs ${live:-nothing}, not $sha; exit 1; fi"
```

`deploys.shapeView` reads the run's stations into the deploy's `steps`
(derived at read, never stored), so the Deploys view and `cast line deploy
show` draw them from the one home.

## DP9. A failed step comes back to the line

Every step station's failure routes to Returned (`cast line deploy return
dp-N`), which reads the failed station from the run, reports the deploy
`failed` ("Stopped at Gate." and the step's words), and files one finding:
source `deploy`, kind `regression`, and an issue key per project, target and
step (`deploy:<project>:<target>:<step>`). `deploy` is a source whose finding
opens a problem (signals.ts `CAUSE_OPENING_SOURCES`), so the first failure
of a step opens a problem on the project's line, and every later failure of
the same step joins it, whichever deploy it was. The finding carries the
deploy, its sha, the run's url, the fixes it carried, and what the step
said. The carried fixes stay shipped and wait for the next deploy; the
problem runs on the line like any other.


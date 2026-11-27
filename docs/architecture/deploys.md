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
| `ship_run` | the personal flow run whose end recorded it (DP11): one deploy per run |

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
   target whose code holds a merge, on the same code (`causeHistory
   carryingDeploys`, the same rule a problem's timeline reads; DP3).

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
- When `target` names a target `.codecast/deploy.toml` declares (DP10), that
  file is the command's one home: the line sends the target's `run`
  (`lineDeploy.ts withDeclaredTarget`, read by publish, `cast line profile`,
  `cast line deploy --go` and every deploy's steps). A `command` beside it is a
  copy for CLIs that read only line.toml (1.1.211 and older), and a copy that
  drifted from the target warns. The daemon reads profiles without it, so the
  deploy files stay off its static graph.
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
every merge it is the first live deploy to hold.

A deploy holds a merge when the merge is in its code, never merely because it
went live after the merge: a deploy cut at 00:07 and live at 01:06 does not
carry a fix merged at 00:14 (Union's dp-412, Nov 6). Main has one order,
`commits.main_at`, stamped per push, and each live deploy keeps its sha's place
in it as `cut_at` (stamped by `deployTargets fillDeployRange`). A merge is held
when its commit's place on main, else its recorded time (which follows its
push), is at or before the cut. A deploy whose sha main never saw (a source
naming only a version) is read by time, live at or after the merge.

A placed deploy (a `cut_at`, after a placed live deploy on its target) also
carries every problem named by a commit in its own range on main: after the
previous deploy's cut, at or before its own (`deployCarries carriesForMarker`). The
commits table keeps every landing a problem had, by a run or by hand, each with
its place on main, while `tasks.landed` keeps only the newest, so for a placed
deploy `tasks.landed` decides nothing. A commit counts for a problem only when
its own message names it: a commit's `task_ids` also take the branch it was
first pushed on, and a fix branch's push lists main commits it merely contains.
A landing known only by its branch is a run merge, matched by sha. A problem's timeline, its
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
markers, ten per call, oldest first, after the merges the rule reads change; it
stamps each deploy's `cut_at` first. `deploysBackfill:stampRunKeys` stamps
`workflow_run` (the Actions run a deploy's url names) on deploys recorded
before it, a page per call from `cursor`. Run them
through `packages/convex/run.sh`.

## DP7. Where deploys show

- `dp-N` is a reference everywhere (entity type `deploy`): a pill whose icon,
  colour and last word are its state (waiting, going out with its elapsed
  time, live, was live once replaced, failed, cancelled), opening
  `/flows?view=deploys&deploy=dp-N`. A GitHub Actions run url in a message,
  and a run's bare id after "run" or "deploy" ("Deploy 44822506482"), is the
  same pill when that run carried a deploy (`deploys.get` takes either), and
  stays as written otherwise.
- A merged pull request's and a main commit's pill end with how far the change
  has gone (DP16).
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
- The Deploys page in a personal workspace shows every project the person
  ships at once: a row of project chips (multi-select, all on) filters the
  page, each project wears its repository's face (a drawing in the role icon
  language, `repo_icons`, asked for by the first deploy `recordDeployMarker`
  records into the workspace, whatever path reported it; until it is drawn,
  the name's first letter in the same color), and the columns mix the
  chosen projects' runs and deploys. A run on its way shows the Check ·
  Review · Land track of a flow that lands straight to main (`track:
  "direct"`), or the pull request's steps (`track: "pr"`). It has no pause or
  rollback controls; those are a team's. It reads the person's own workspace
  (`user:<id>`): `deployTargets.view`, `deployRefs.recentForTeam`,
  `workflow_runs.shippingRuns` and `checkouts.forTeam` each take `workspace`
  in place of `team_id` (exactly one). For a personal workspace
  `recentForTeam` returns every deploy of the last 30 days (up to 500) and
  each repository's newest deploy and newest live one, whatever their age,
  so a busy project never pushes a quiet one off the page.

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
| Finish | a target's `finish` (DP15), once it is live: the deploy is reported live first, so a failure here only notes it and files the finding | passes with a note |
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
`failed` ("Stopped at Send: <cause>" over the step's last words), and files one finding:
source `deploy`, kind `regression`, and an issue key per project, target and
step (`deploy:<project>:<target>:<step>`). `deploy` is a source whose finding
opens a problem (signals.ts `CAUSE_OPENING_SOURCES`), so the first failure
of a step opens a problem on the project's line, and every later failure of
the same step joins it, whichever deploy it was. The finding carries the
deploy, its sha, the run's url, the fixes it carried, and what the step
said. The carried fixes stay shipped and wait for the next deploy; the
problem runs on the line like any other.

The cause is one line of the step's whole output (`contracts/lineDeploy`
`deployCauseLine`): the last line that names what it needed (`An Expo user
account is required`) or an error, nearest the end where the step failed, else
the last line that is no warning or stack frame; a wrapper's line that only says
the command it ran failed (npm's lifecycle lines) never counts. The step prints it last (`exited 1: <cause>`), Returned
puts it in the note's first line, and every surface that heads a failed deploy
shows that line (`deployNoteHeadline`, which reads an older note's log the same
way) with the whole note behind it.


## DP10. A repository's deploy targets

Everything above is a line's deploy of fixes. A repository also has targets
of its own, each a place its code goes live on its own clock. Codecast's are
the backend (Convex), web (Railway), the CLI release, the mobile OTA and the
desktop app. A codecast change's Ship run sends each one its files touch
(DP15): the backend at Merge, before the merge (its `ship` step; Deploy only
waits for it); the CLI and
mobile as `release` targets; web deploys itself on push. Desktop is `press`:
its release signs with a Developer ID certificate on the machine that runs it,
builds that checkout's working tree and pushes its own version bump, so a
person sends it and the run waits. They are declared once, in the checkout:

- A `[[target]]` table of `.codecast/deploy.toml` is one. `name` names it,
  `run` is the command that sends it (from the checkout's root; `$sha`,
  `$deploy`, `$actor` expand), `when` the paths whose change it ships, `runs`
  where that happens (`here`, the publishing checkout, the default; `push`,
  the target deploys itself when main moves and has no command), `live` how
  codecast reads what runs there (below), `rollback` the command that puts
  the previous version back, and `policy` who starts it (`press`, a person's
  Deploy, the default; `auto`, it goes out by itself when CI on main's head
  is green; `release`, it goes out with every release, DP15). `after`,
  `ci` and `finish` give a release its order and steps, and `deadline` how
  long a change flow's Deploy stage waits for it (DP15).
  `ci`, `gate`, `rollout` and `finish` are the deploy's step commands
  (DP13), each run like `run` with `$sha`, `$deploy` and `$actor`; a step
  left out passes with a note.
  `workflow = "deploy.yml"` names the GitHub Actions workflow file every
  deploy of the target runs as, whoever dispatches it (DP11).
  `ship = "<step>"` ties it to the `[[ship.deploy]]` step of
  workspace.toml that sends it at a ship: the target takes that step's `run`
  and `when` (unless it gives its own), and the ship records a deploy of it.
  A target with no `ship` step is never sent by a ship: only a deploy from
  codecast or a release script sends it.
- A line profile's `[line.deploy]` (Union) is one more target, read the same
  way (`contracts/deployTargets targetFromLineDeploy`).

`live` readers: `marker` (the deploy path records each deploy: deploy.sh, a
ship pass, a codecast run's watch station, a release script's `cast ship
mark`), `github-status:<context>` (a commit status or deployment on the
default branch; Railway posts `codecast - web`), and `json:<url>#<sha
field>[,<version field>]` (a document naming the commit it was built from,
like the CLI release's latest.json `sourceCommit`).

The targets are published per repository to `deploy_targets` (workspace key
of the repository's team) by every line profile publish and by `cast line
deploy targets --publish`, with the machine and checkout that published
them: where a deploy of a `here` target runs. A change that lands
`.codecast/line.toml`, `deploy.toml`, `workspace.toml` or a file in the
line's own folder is republished by its run's Deploy station (`workflow/republishLanded.ts`):
it checks out a clean detached worktree of the merged commit, runs `cast line
profile --publish` there (`cast line deploy targets --publish` for a
repository with no profile) with `CODECAST_PUBLISH_ROOT` naming the run's
checkout, so the published root stays where the targets' deploys run, removes
the worktree, and its last line says whether it did. The run's checkout need
never hold the commit. A cast that does not read a key the files name would
publish without it, so the publish runs with `--strict`: the cast that
publishes checks the files, publishes nothing and exits 3 naming the keys, and
the line names the cast that reads them (in codecast's own repository, the
release after the version the commit's `packages/cli/package.json` holds). A target the checkout stops
declaring is retired, not deleted. Every reader (the CLI, the server, the
Deploys page) parses through `contracts/deployTargets`.

The targets have their own file because released CLIs validate
workspace.toml strictly (an unknown key in `[[ship.deploy]]` or at the top
level refuses the whole manifest, and with it `cast ship` and workspace
acquire). Keep workspace.toml to the keys the oldest CLI in use reads.
deploy.toml is read past that: a target key this CLI does not know is
ignored and named (`cast line deploy targets` prints it), so a file written
for a newer CLI still deploys. CLIs before 1.1.249 refuse an unknown target
key instead, and a pressed deploy of that repository fails on them: raise
`min_cli_version` to a release that knows a key before any repository writes
it (`gate` and `rollout` came after `ci` and `finish`, which 1.1.235 reads).

`[ship]` is the one workspace.toml table read the same way from 1.1.284:
workspace acquire and the other readers skip a `[ship]` key they do not
know. `cast ship` and the merge station's before-merge deploys still refuse
it, naming the key (a newer cast's setting? cast update; a typo? fix it),
because a skipped key may route the pass or name its deploys: a misspelled
`flow` would push past the flow's review, and a misspelled `deploy` would
merge a client before its backend. CLIs before 1.1.284 refuse it everywhere
with the whole manifest, so a repository adds a `[ship]` key only once
`min_cli_version` reaches a release that reads it.

## DP11. Every way a target goes live leaves a dp-N

Each path records into the repository's team when one of the caller's teams
works on it (`changesDeploy.findDeployTeam`: the GitHub App's team, else the
one team publishing a checkout of it), and into the caller's own workspace
(`user:<id>`) otherwise (`findDeployWorkspace`). A personal deploy has no
`external_events` marker: there is no team event stream for it to feed.

- **A ship.** `cast ship checkout` posts its pass to `ship_passes`
  (`deployTargets.recordShipPass`): the commits with the session behind each,
  the groups held back, each deploy step's result. Every step a target names
  (`ship = "<step>"`) records a deploy of that target after the push with the sha the ship pushed (the
  tip it built, with a note, when nothing was pushed), and a failed step
  records a failed deploy. Uncommitted files under the step's paths when it
  ran are counted on the deploy (`dirty`), since they went out too.
  deploy.sh leaves the mark to the ship when it runs under one (`CAST_SHIP`).
- **deploy.sh by hand** marks HEAD and its uncommitted file count
  (`cast ship mark --dirty`). Run by a codecast deploy (`CAST_DEPLOY_ID`), it
  names the deploy (`--deploy dp-N`), and the mark finishes that deploy with
  the sha that actually went out.
- **A target that deploys on push.** GitHub's `status` webhook on a commit of
  the default branch, and `deployment_status`, with a context or environment
  a target's `github-status` reader names: pending records a running deploy,
  success makes it live, failure or error fails it
  (`deployTargets.recordGithubDeployStatus`).
- **A target's deploy workflow.** Every `workflow_run` webhook on the default
  branch of the file a target's `workflow` names is that target's deploy
  (`deployTargetsCi.recordWorkflowRunDeploy`), so a run dispatched by hand
  shows while it runs and when it fails: queued or in progress is running,
  success live, failure failed, cancelled or skipped cancelled. The commit a
  dispatched run ships is the one its run-name names (a dispatch input:
  Union's `run-name: Deploy <sha> for <actor>`), the commit main knows first;
  any other run ships the commit it runs on, since its title is a commit
  subject. A requested delivery can come before GitHub fills the run-name in,
  so a later delivery that names the commit corrects the head the first one
  recorded. One workflow is one target's: a file two targets name is refused.
  The run's url is the deploy's, stamped as `workflow_run` (indexed, so a
  run's link in a message is a point lookup), and a marker from a run speaks
  only for that run's deploy: a second run queued behind the first is a deploy of its own, a
  rerun (attempt 2) another, and a run finishes an open deploy asked for from
  codecast only when it ships that deploy's sha or the deploy names none yet.
  A later report of the same sha (the target's live reader) finds the same
  deploy. A failure fires `deploy_failed` like any other.
- **A release document.** `deployTargets.pollLiveReaders` (every five
  minutes) reads each `json` reader and records a deploy when it names a new
  commit or version: the CLI release goes live when latest.json says so.
- **Release scripts.** scripts/deploy-all.sh marks `mobile` after `eas
  update` and `desktop` after its release; release.sh marks `desktop` itself
  when it commits the version.
- **A personal flow run's end.** A run in a `user:` workspace that ends is
  read for its deploy (`lib/runDeploy.ts`, scheduled by the runner's last
  report as `runDeploys.record`; `personalDeploysBackfill:run` for runs that
  ended before). Completed at an exit labelled Live or Shipped, it records a
  live deploy; at Deployed, unverified, a live one noted as not seen running.
  Ended at a station labelled Deploy failed, or whose id says the deploy
  failed (`deploy_failed`, `deploy__failed`), it records a failed deploy only
  when the step that ran the deploy failed (the personal flow's Deploy pinned
  `failed`, or a `ship`/`deploy` command station failed), with that step's
  words; when that step succeeded and only a station watching for it failed
  after (`deploy__wait`), the deploy went out, so it is live, noted as
  unconfirmed. Ended anywhere else (Landed: nothing documents a deploy), it
  records nothing. The deploy goes to `production` of the GitHub repository
  the run's sessions work in (the task's session, the run's, the one that
  pressed Ship), at the run's merge sha, else the sha a deploy or landing
  station pinned, else one a station's output names (`<sha> is on main`, a
  ship step's line that starts with the sha it shipped), with source `<flow>
  flow`. It carries the run's task and lists the landed commit under the
  session that pressed Ship, so its card names both; with no sha, the card
  still names the run's task and that session. Each run is a deploy of its
  own, never merged into another of the same sha. A run with no GitHub
  repository, a repository one of the person's teams works on (its team's own
  path records it) and a line-deploy run (DP8, already a deploy) record
  nothing. A run resumed after it ended (Deploy failed, then Live) updates its
  deploy to what the new end says, with one exception: a deploy that went
  live stays live when the resumed run's redeploy fails, at its sha, with
  "A later redeploy failed: <reason>" added to its note. An unchanged end
  changes nothing.

A deploy that goes live fills its range on main (`fillDeployRange`): its
previous sha (the target's live deploy before it) and the commits between
that touch the target's paths, each with its session.

## DP12. CI on main and what waits on each target

`commit_ci` holds CI on a repository's default branch per commit: one row per
commit and workflow (every workflow run, queued, running or done) and per
other app's check suite (Actions' own suites are its workflow runs; an app
that reports by commit status leaves its suite queued forever and is not
counted). A commit's state is `commitCiState`: failed over running over
passed, a cancelled run saying nothing, a workflow's newest run speaking.

`commits.main_at` orders the default branch: each push stamps its commits a
millisecond apart from the push's time, and the backfill orders older ones
from GitHub's history. A target's waiting queue is the commits after its live
deploy's sha that touch its paths, each with its session (the
`Codecast-Session` trailer), its tasks and its CI, grouped by session
(`groupQueueBySession`). When the live sha is not on main as codecast knows
it, the queue is unknown rather than empty.

`deployTargets.view` (team, or repository) returns every target with its
live deploy, the deploy going out with its steps, its recent deploys (each
naming the sessions whose commits it carried), and the queue: the newest 50
commits whole and the total, main's head and its CI.

## DP13. Deploying any target from codecast

`deployTargets.request` (team or repository, target, `action`) asks for a
deploy: `deploy` sends main's head, or the commit `sha` names (a commit on
the default branch after the live one; a target whose command takes no `$sha`
sends the tree it runs in, so only main's head can be named for it), and the
deploy row records it from the start, so every step judges and sends that
commit; `redeploy` sends an earlier deploy's sha
again (only a command that takes `$sha`; a command that deploys the tree it
runs in cannot), `rollback` runs the target's rollback back to the live
deploy before the current one, or the one named. It refuses a `push` target,
a second deploy while one is going out, and a target no machine publishes.
The row is `requested`, carries the commits it will send, and queues
`line_deploy` on the publishing machine; `cast line deploy run dp-N` there
runs the line-deploy graph with the target's commands
(`lineDeploy.deployProfileFor`): the send is its command or rollback, and a
target read from elsewhere gets a live step (`cast line deploy await-live`)
that waits for its reader to record the sha. Its other steps run the
target's own commands (DP10), and a rollback runs none of them. A checkout
whose HEAD does not hold the deploy's commit (a shared checkout with others'
edits is not kept level) runs what that commit declares, not its older files
(`deployAtCommit.ts`). The commit is the deploy's sha, or, for a deploy that
names none yet (a target whose command takes no `$sha`, asked for by `cast
deploy` or the Deploys page), origin's head, fetched, which the first step then
fixes as its sha. The step reads the target as that commit's deploy.toml has
it, and runs a shell script the command starts as the commit has it, with
`bash -c` from the checkout's root so `$0` is still its path; a script that
runs itself again from disk (backend's deploy.sh) then runs the checkout's
copy, and the step's log says so. A commit the checkout lacks is fetched from
origin first; one origin does not have either leaves the checkout's own files,
and the log says that too. `cast deploy` plans from the commit's targets the
same way. A send that prints `Waiting for …` (a release in
flight, CI on main) puts that line on the running deploy's note, and the line
it moves on with after it, so whoever waits on the deploy reads why: `cli: dp-13
goes out after the CLI release in flight (runs 4604…), then sends 1a2b3c4`. The steps:

- `ci` before the send: the sha's verdict (`cast line deploy ci`).
- `gate` after the send: the gate's verdict on what went out.
- `rollout` after the gate: the rollout finishing.
- `finish` once live: what follows (`$version` expands).

A target whose send dispatches one GitHub Actions run that does CI, the gate
and the rollout itself (Union's deploy.yml) mirrors that run's jobs as steps
with `cast line deploy follow --jobs <names>`: the send's output names the
run (`https://github.com/<repo>/actions/runs/<id>`), the deploy records it,
and each later step reads it as `CAST_DEPLOY_URL`. A step passes when its
jobs pass and fails when one fails or is cancelled. A job the workflow
skipped passes and says "skipped by the workflow", unless the run ended
failed, which means a job it needs did not pass, and then it fails.

```toml
ci      = "cast line deploy follow --jobs ci-verdict"
gate    = "cast line deploy follow --jobs gate,evals"
rollout = "cast line deploy follow --jobs deploy"
``` From a terminal: `cast line
deploy --target <name> [--redeploy dp-N | --rollback [dp-N]] --go`.

A deploy that goes live fires `deploy_live`, one that fails `deploy_failed`
(trigger events, `source` the target), whoever sent it.

## DP14. Backfill

`deployTargets:backfill '{"repository":"owner/name","commits":150}'` reads
the default branch back from GitHub through the App: its last commits in
order with their files and sessions (main_at), the workflow runs and other
apps' suites on them (commit_ci), and the commit statuses its github-status
targets name (their deploys). A json reader records its target's live sha on
its first read.

## DP15. A release: every target main moved past, in order

A team ships main many times a day; each push leaves some targets behind
(a CLI release not cut, an app update not published). A release sends them:

```
cast deploy                 every `release` target main moved past, and the push targets it waits on
cast deploy cli mobile      those targets, whatever their policy
cast deploy --dry-run       what it would send, wait for and leave alone, and why
cast deploy --files "<paths>" --carrying <sha> [--except <targets>]   only what one landed change touches, sending main's head
cast deploy --sha <sha>     every deploy of the release makes exactly that commit live (request sha), not main's head
cast deploy                 pins origin's head as the release plans it for each target whose command takes $sha,
                            so a push after planning never rides along; a commit codecast has not read from
                            GitHub yet is asked for again for up to two minutes
```

`deployRelease.ts planRelease` reads the checkout's targets (the file is the
authority) and what the server records live on each. A target is behind when
no live deploy holds the release's sha (git ancestry, as the Deploy stage
decides it, FL4) and a commit since its live deploy touches its paths; one
whose live sha is not in the checkout's history counts as behind. Then:

- `send`: a `here` target whose policy is `release`, or any target named on
  the command line. It is asked for like the Deploy button (`deployTargets.request`)
  and its line-deploy graph runs on this machine when this machine publishes it,
  in the checkout that published it; else its publishing machine runs it and the
  release waits on the dp-N. A target whose deploy another release is already
  sending waits for that one, and sends again only when it did not carry the sha.
- `wait`: a `push` target that is behind deploys itself; the release waits
  until a live deploy holds the sha.
- `skip`: `press` and `auto` targets the command did not name, with why.

Five keys of a `[[target]]` make the release a declaration rather than a
script. They are read only by the CLI; the server's copy leaves them out
(`publishableTarget`).

| Key | What it does |
|---|---|
| `policy = "release"` | the target goes out with every release, and with a change flow's Deploy stage when the change touches it |
| `after = ["backend"]` | sent only once those targets are live with this release; an `after` the release does not touch is not waited on; a cycle or an unknown name refuses the file |
| `ci = "<command>"` | the line-deploy graph's CI station: the deploy sha's verdict before the send (`cast line deploy ci --workflow ci.yml`) |
| `finish = "<command>"` | the Finish station once live; `$version` is what went out (`cast force-update $version --deploy $deploy` after a CLI release, DP20) |
| `deadline = "45m"` | how long a change flow's Deploy stage waits for the target to go live, from when it can first go out, before it calls the deploy stuck; default a day for a target a person or a role sends, 60m for one it sends, 30m for one that deploys itself; at most 24h |

Targets run side by side except where `after` orders them; a target whose
`after` failed is not sent. The command exits 1 when any target failed.

A release pushes commits of its own (the CLI release's Finalize step commits
the version bump to main before it publishes `latest.json`), so once its
targets are done `cast deploy` levels the checkout it ran in onto origin
(`land/levelSweep.ts levelOne`, under the repository's `[ship] level` opt-in)
and prints what it moved. The checkout ends a release level with what it
released, rather than a commit behind until the daemon's sweep comes round.

A change flow's Deploy stage is the same release narrowed to one change and
held to a promise (`workflow/awaitDeploy.ts`, the `deploy` segment's station
`cast flow await-deploy`): Live means every target the change's files touch
carries it. It starts only from the commit the run merged: `$run_dir/
merge.json`'s sha (Merge, or Land, FL4), else the merge recorded on the run
(`run.merge.sha`, which `cast line merge` writes without a merge.json). With
neither, or a sha that is not on origin's default branch, it stops at once at
Not merged. Its targets are the ones the merged commit declares: its
`.codecast/deploy.toml`, `workspace.toml` and `line.toml` read from git, never a
checkout's working tree or the server's published list, either of which can
still name a target the commit removed. Of the targets the change's files touch:

- `release` targets that run here: it sends them, `cast deploy <targets>
  --carrying <merged sha>` in a process of its own, then waits for them. One with a `ci`
  step is sent only while main CI on main's head (the commit its deploy would
  send) is green by the verdict that step reads (the workflow `--workflow`
  names, by its conclusion, so an advisory job that fails holds nothing; every
  CI workflow when it names none, leaving out the deploy workflows targets name
  with `workflow`). Red or running main holds it, not fails it, and it goes out
  the moment a fix or revert turns the head green. A send that went out at a
  head main moved to between the gate and the request, and failed there while
  that head was red or running, is held the same way and sent again at green.
  One whose `after` target the run sends goes in the same `cast deploy`, which
  orders them; one whose `after` target the run does not send (a person, a
  role, a push, the server, or a target held back with `except`) is held unsent,
  `mobile: held until backend is live with 1a2b3c4 (held 3m, then 60m)`, until that
  target's record shows a live deploy carrying the commit (the Merge station's
  pre-merge deploy counts). An `after` the change does not touch is not waited
  on. A flow that composes the segment with `send=""` sends none of them and
  waits for a deploy someone else sends. `send` defaults to `release`, the
  library's default: a flow that composes the segment without it sends.
- A target Merge sends (one whose `ship` step runs `before_push`), whatever
  its policy: Merge deployed it from the change rebased onto main and recorded
  it at the landed sha, so the stage only waits, ten minutes by default, for
  that record. It never sends it, since a send from the checkout deploys the
  checkout's working tree. With no deploy carrying the commit it ends stuck,
  saying Merge's send failed or was not recorded.
- `push` targets, whatever their policy: it waits until their own deploy
  carries the commit.
- `auto` targets: it waits until the server sends them from green main CI (every
  CI workflow, deploy workflows left out).
- `press` targets, and the target the line profile's `[line.deploy]` sends
  whatever its policy (by a person's Deploy, or the line's role, DP4): it never
  sends them and only waits, a day by default, `production: waiting for a person
  to send it (2h of 24h)` or `waiting for @release to send it`. The station
  parks, so that day holds no slot.

A target held back with `except` is not waited on; the last line names it. A
target the stage only waits on that the server has no record of has no reader to
say it is live: while another target can say the commit is live, it does not hold
Live, and the last line names it (`aivery-operator has no record on the server,
so nothing says when it is live; not waited on`). Every look reads the server
again, so a target published mid-wait is waited on again. One an `after` names
still holds its dependents. When no target can say so (an empty answer, every
target unrecorded), the stage waits and its deadlines end it stuck. A
deploy sends main's head (DP13), so a later commit's deploy that carries the
merged one satisfies the wait. When the send ends and a target it sent has no
deploy carrying the commit, the stage fails at once rather than wait out the
deadline, naming the sha the deploy did send: the checkout that publishes the
target may be behind origin. A deploy that sent nothing (stopped at CI, or at
Send on a refusal that comes before any upload: a release already in flight, a
wait for one that ran out, another person's machine, missing credentials)
makes the stop say no deploy took the commit out (`No deploy took 1a2b3c4 out:
cli dp-3789 stopped at Send before sending anything (<cause>)`), and the change
reads Not sent. Any other failure, Send's included (an OTA can publish to one
channel and fail on the next), says the deploy that carried it failed. A target the stage only
waits on names since when nobody has sent it (`nobody has sent desktop since
46f3912 in dp-3793`).

Every progress line names each target, what it waits for, how long and its
deadline: `cli: dp-13 sending 1a2b3c4 (12m of 45m)`. A target's deadline starts
when it can first go out: every `after` target live with the commit, whoever
sends it, and, when gated, main green, so a target behind a person's day never
spends its own hour waiting for that person. Until then it reads `held 12m, then 45m`, as in `cli: waiting on main CI at 9f8e7d6
(red since 5e4d3c2: test-cli; held 12m, then 45m)`; "red since" names red
main's open culprit for the repository (main-red.md, `/cli/main-red/open`) that
the commit's history holds, and, when the server names none or cannot answer,
the oldest commit of the red run main's first-parent history ends in. Deadlines default to
a day for a target a person or a role sends, an hour for one the stage sends and
half an hour for one that deploys itself, ten minutes for one Merge sent; `deadline`
overrides each, up to a day.
The whole wait is capped at the longest deadline and an hour, from the station's
first start. `$run_dir/deploy-clock.json` keeps that start for the merged commit
across a station re-run mid-wait; it is deleted wherever merge.json is, and a
resume of a run that ended at Deploy stuck starts a fresh clock. The station's
own timeout is 15 minutes past the cap. When every target is live it prints
`Live: 1a2b3c4 on backend dp-12, cli dp-13.` and exits 0. A deploy that would
carry the commit failing ends it at Deploy failed. A target past its deadline,
or any target still waiting at the cap, posts one blocker on the run's task
naming the target, the commit and its last state, and ends it at Deploy stuck.
Deploy targets have no owner of their own, so the task's blocker is the one
card.

The personal flow's Deploy (flows.md FL4) is not this stage: an agent runs the
deploy the project's docs name, reads no targets, and ends Live only on seeing
the landed commit run. Its run's end records the deploy (DP11).

The `cast-deploy` skill ships everything uncommitted in a shared checkout and
ends with `cast deploy`, so what a project deploys, in what order and with what
follow-ups lives in its `.codecast/deploy.toml`, not in the skill.

## DP16. How far a change has gone

A merged pull request (`owner/repo#N`) or a commit on main (`owner/repo@sha`)
reads its reach through `deployReach.get`: for each target whose paths the
change touches (the pull request's files, else its merge commit's), one of
the states below. A target that names no paths ships every change only in a
repository whose targets name none; beside targets that name theirs (Union's
production beside its line-profile apps) it is left out, since it cannot say
what a change touches.

| State | When |
|---|---|
| live | the target's newest live deploy holds it; the deploy named is the first live one that did |
| going out | a running deploy holds it |
| queued | a deploy asked for, that no machine has started, holds it |
| rolled back | an earlier live deploy held it and the one live now does not |
| deploy failed | a deploy started after the live one held it and failed |
| not live yet | none of the above |

A deploy holds a change by DP3's rule: the same commit, else its sha's place
on main at or after the change's, else (no place) live at or after the merge.
A deploy is stamped with its place once live; an open or failed one is placed
from `commits.main_at` at read. The change's state is the one that most needs
an eye: failed, rolled back, not live yet, queued, going out, live, over the
targets still shipping: a target with nothing going out and no deploy in a
week (Union's aivery-operator, a backend copy shipped rarely) keeps its row
but would otherwise hold every change at not live yet; when every target is
dormant, all of them speak. A pull request
names its commit on main by `pull_requests.merge_commit_sha`, which the closed
webhook and the GitHub sync write. The rule is `contracts/deployReach`; the
web's store holds each answer in `deployReach`, keyed by its ref.

## DP17. Pausing production

A pause (`deploy_pauses`, one standing per repository) stops every send to
the repository's targets: `deployTargets.request` refuses a deploy or a
redeploy while one stands, and auto targets wait. It records who paused, why
and when, and what ends it: nothing, when the person who paused or the
Release Captain lifts it, or a commit green on main (a rollback's, DP18).
A lifted pause is kept as the record (`lifted_at`, `lifted_by`).

Pausing, lifting and rolling back are a permission of their own, separate
from any deploy grant: team admins (founders) hold it, a member holds it
once an admin grants it (`team_memberships.production_pause`, `cast line
deploy grant <person>`), and a role holds it with the `production-pause`
authority grant (the Release Captain) when the call comes from its session.
Lifting is for whoever paused, or the Release Captain.

`cast line deploy status|pause|lift` (`--json` for scripts; deploy.sh reads
it before it sends) and the Deploys page. `deployTargets.view` returns
each repository's production once (`productions`: its pause, and whether the
viewer may pause and may lift), never a copy on each target.
The shared rules are `contracts/deployPause`.

## DP18. Codecast's deploy queue

A target that names its `workflow` is sent by codecast itself: it
dispatches the workflow through its GitHub app (the installation needs
`actions: write`) on the default branch with an exact `sha`, the asker's
first name as `actor`, and for a rollback the target's `rollback_inputs`
(Union's `{ components = "backend-web" }`), so no publishing machine is
needed (`deployDispatch.ts`). A rollback always goes this way; a deploy or
redeploy goes this way when no machine publishes the target. The deploy row
is the queue entry: `dispatch.state` is queued, sending (claimed by one
send), then sent, and the run's webhook (DP11) finishes it by its sha, never
by another commit.

A deploy is sent only when nothing of its target is going out: no deploy
running or sent without a run yet, and GitHub listing no run of the workflow
queued, in progress or waiting. A workflow's concurrency group keeps only
its newest pending run, so a second dispatch would drop the one waiting. So
a rollback is never refused for a running deploy: it waits in the queue and
goes out when the run ends (a finished run's webhook runs the queue, and a
sweep every two minutes is the backstop). A deploy that has heard nothing
from GitHub for five minutes (running, or sent with no run named) is read
from GitHub by that sweep and recorded as its webhook would have been, so a
lost webhook never holds the queue. While production is paused only the
rollback that paused it is sent: the pause is read again last, just before
GitHub is asked to dispatch.

A pause stops what it catches: a deploy still queued is cancelled at once,
one claimed for sending is cancelled at that last read, and a run that has
not reached rollout (no `deploy` or `rollout` job started) is cancelled on
GitHub, including a run that starts after the pause (one sent before it). Each carries codecast's `cancel` (who, why,
when), the only cancel that counts as a pause; a run cancelled anywhere
else is neutral and is never retried.

## DP19. Rolling production back

`cast line deploy rollback [dp-N] --reason "<why>"` (and Roll back on the
Deploys page) puts an earlier live deploy's commit back on the repository's
workflow target: the one before the live deploy, or the one named
(`deployRollback.rollbackCore`). It is held like a pause (DP17), and in
order it:

1. queues the rollback (DP18) with the target's `rollback_inputs`, behind
   whatever is going out;
2. reads what it takes off production, the commits on main after the
   commit it puts back up to the live one, and whether any carries a
   migration (a path under `migrations/` or `drizzle/`);
3. files the commit that will end it to the Release Captain (the role
   holding the pause authority, `@release` first) as a task: a revert of
   each commit, or a fix forward when a migration rules the revert out (or
   the range could not be read whole: unknown, or more commits than codecast
   reads at once);
4. pauses production with that task as what ends it, replacing any pause
   standing, so only the rollback is sent;
5. cancels what the pause catches (DP18).

A deploy request for a rollback that skips this is refused. The pause lifts
itself once the first commit on main after the rollback that names its task,
or a commit after it, passes CI: the run of the target's `ci_workflow`
(`ci.yml`), else all of the commit's CI. A merge alone does not lift it, or
a deploy of main's head would ship the change again while its CI runs. The
webhook of each passing CI run checks, and a sweep every five minutes is the
backstop. When main has more commits since the rollback than codecast reads at
once and the task's commit is not among them, the pause stays and its
reminder says the ending commit could not be found, so its lifter lifts it by
hand. Whoever paused, or the Release Captain, can lift it sooner.

A standing pause reminds whoever lifts it every four hours, on weekdays
from 9:00 to 18:00 in the team's zone only: a rollback's reminds the
Release Captain of its task, any other the one who paused
(`production_paused`).

## DP20. A CLI release makes the team's machines update

A machine below its CLI floor updates itself and restarts its daemon. Its
floor is the highest of the global `min_cli_version` (platform staff only,
`systemConfig.setMinCliVersion`) and the floor of each team its owner
belongs to (`teams.min_cli_version`), so a team floor never lowers the
global one. The heartbeat and the daemon's forced-update check
(`systemConfig.getMinCliVersion` with its token) both serve that highest
floor (`systemConfig.effectiveMinCliVersion`).

A team's admins raise its floor, and so does its Release Captain: the role
holding the team's deploy grant, from its session
(`teamCliFloor.set`). A floor only rises. `cast force-update <version>
--team <team>` sets it; without `--team`, platform staff set the global
floor and anyone else their active team's.

Codecast's `cli` target finishes with `cast force-update $version --deploy
$deploy` (releaseFinish.ts). Forcing restarts every daemon, so it is worth
it only when the daemon changed: the finish compares the daemon build id
(daemonBuildIdCompute) of the tree at the deploy's sha with the one at its
`previous_sha`, the release live before it, each read from `git archive`.
Equal ids force nothing. Different ids, or no previous release on record,
raise the deploy's team floor to the release, then read the team's fleet
(`teamCliFloor.fleet`: every member's machine seen in the last day) each
minute for up to 20 minutes (`--wait`), until no online machine lags. The
decision and the fleet (took it, lagging, offline, cannot update itself:
a source checkout or a managed install) are appended to the deploy's note.

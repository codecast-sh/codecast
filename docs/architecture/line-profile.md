# The line profile: one line per project

`the-line-end-to-end.md` describes the graph every change follows. This
document says what differs per project and where a project declares it. The
graph, the card, the gate and the stack are the same everywhere. What a
project owns is its own answer to six questions: what do we listen to, what
are we trying to move, what do we hold work to, how do we check a change, how
do we prove and evaluate one, and who answers the card. Sections are numbered
LP1 onward.

## LP1. What belongs to a project

A project (a codecast `projects` row) is where a problem lives: its goals, its
expectations, and the person who answers its cards (the-line-model.md LM1).
Sources and flows are the team's.

- A signal carries `project_id`, set by what it is about: the expectation it
  breaks names its project; else its source's default project, when the
  source is single-purpose; else Ground places the problem. A new cause is a
  task in that project. The attach judge looks only inside the project.
  Fingerprint attach looks across the workspace: an open cause holding the
  key takes the signal wherever it sits, and a signal filed for another
  project records that project in `filed_for_project_id` (the-line-end-to-end.md LE4).
- `cast signal add` takes `--project <ref>` when the filer knows it. Without
  one, placement follows the order above; the repo profile's `[line] project`
  is the last default, for signals nothing else places.
- `cast goals --project <ref>` renders that project's charter and the
  initiatives that carry it. The ground node passes the problem's project.
- `/line` lists every project's problems with a project filter. Flows are
  listed across all projects.
- Admission is per role (the-line.md L9), and a role's scope names projects,
  so a cause with a project is seen by the role that owns it. How many runs
  work at once is counted per runner machine, across every line it runs (LE6).

## LP2. The profile file

A repo declares its line in `.codecast/line.toml`, tracked the way
`.codecast/check.toml` is. One file may hold several projects when one repo
serves several.

```toml
[line]
team = "Union"                       # workspace for writes from this repo
project = "Agent Quality"            # default project for signals filed here
principles = ["outreach/docs/line/principles.md"]
prompting = "outreach/docs/line/prompting.md"   # omitted: codecast's standard
size_budget = 400                    # changed lines before a run returns to plan
watch_days = 7

[line.commands]                      # run from the run's worktree; $vars expand
check = "cast check && cd outreach/backend && bun run test:touched"
prove = "bun outreach/backend/scripts/line.ts prove --task $task_id --dir $run_dir"
eval  = "bun outreach/backend/scripts/line.ts eval --base $default_branch --dir $run_dir --out $run_dir/reps.json"
ship  = "bun outreach/backend/scripts/line.ts ship --task $task_id --branch $branch"

[line.caps]
cards = 5                            # read by nothing: open cards limit no starts (LE6)

[line.caps.stations]                 # the most of the team's running runs a station takes at once
eval = 8                             # a run past it waits outside, the station's clock not started

[line.merge]                         # what Ship does once a pull request is green
auto = false                         # true: Ship on a task or session merges too
method = "squash"                    # squash | merge | rebase

[line.deploy]                        # the deploy stage (deploys.md DP2); run from the repository root
command = "outreach/deploy.sh --sha $sha --actor $actor --no-watch"   # the send step
target = "production"                # what the team's deploy markers name
trigger = "role"                     # person (default) | role (DP4)
role = "release"                     # with trigger = "role": the role that deploys
ci = "cast line deploy ci --workflow ci.yml"          # each step a command (DP8); one left out passes
gate = "cast line deploy follow --jobs gate,evals"
rollout = "cast line deploy follow --jobs deploy"
live = "..."                         # production answering with $sha

[[line.finders]]                     # what this project listens to (LP3)
id = "invariants"
source = "union.invariant"
kind = "regression"
fingerprint = "union:invariant:<id>"
runs = "backend job captureInvariantSnapshots"
project = "Infrastructure"
```

`cast line profile [--json]` prints the resolved profile for the current
directory. The runner loads it once per run, from the run's project directory,
and exposes every value as a variable (`$line.commands.check`,
`$line.principles`, `$line.prompting`, `$line.size_budget`,
`$line.watch_days`), so the shipped template names no repository path and no
tool of codecast's own; a malformed profile stops the run. A command runs from
the run's worktree in its own shell, with `task_id`, `branch`,
`default_branch`, `run_dir`, `run_id`, `project_path` and `worktree` in its
environment (`LINE_COMMAND_VARS`), which is how `$run_dir` in a command
expands. `$run_dir` is the run's files directory, inside the repository's git
directory (`<git common dir>/cast-line/line-<task>`), the same for every
station and never committed.
A repo without a profile gets the defaults: `cast ws check`, no prove or eval
command (the stations pass with a note saying so), codecast's prompting
standard, and the shared principles with no project file.

## LP3. Finders are declared

A finder is whatever writes signals for the team: a backend job, a trigger,
a routine, a person. The profile lists the finders that run from its repo so
the line page can show each one with its last signal and say honestly when a
finder is silent. A finder's `project` is a default for a single-purpose
source (every signal it files is about that one area); a source that sees
many areas names none, and its signals are placed by what they are about
(LP1). A finder types its own signals (LE3) and computes a
fingerprint that is stable across rewording. The profile entry is a
declaration; the finder itself lives where its data lives.

A finder also says how a person names it: `label` (what the team calls the
source, "Aivery corrections"), `what` (one line on what it listens to) and
`group`, the section of the source list it belongs in: `conversations` (what
the product's agents say to people), `people` (what people report or
correct), `product` (how the running product behaves: errors, checks,
metrics) or `pipeline` (the line's own machinery). All three are optional;
a surface without them names the finder by its source.

`opens_causes = true` on a finder is the line's explicit conversion step: a
signal of that source that no open cause holds opens a new cause (LE4).
Without it the finder's signals are held as signals, attaching only to a cause
that already holds their fingerprint. A person's signals open causes without
a declaration.

## LP4. Project commands, one contract each

- **check** exits 0 when the branch is sound. It is the verify station.
- **prove** exits 0 only when the miss is shown: every miss moment fails on
  the base and every guard passes. It writes `$run_dir/proven.json`.
- **eval** writes `$run_dir/reps.json`: per surface, per freeze, per side
  (base, branch), the reps with `passed`, `score`, `reply`, `judge_note` and
  `cost_usd`, plus `gates_failed`. It does no statistics. The shape is
  `EvalRepsFile` in `packages/shared/contracts/evalResult.ts`; a crashed rep
  carries `error` and counts as no verdict.
- `cast line eval-result --reps $run_dir/reps.json --out eval-result.json`
  turns reps into the `EvalResult` the card reads: separation by the one
  Mann-Whitney implementation (`platform/packages/evals/src/analysis/stats.ts`), flips, proven
  freezes, the verdict. Its exit code is the eval station's. A failed suite
  gate (`gates_failed`) reaches the card as its own red check, "Suite gates",
  naming each failing scenario, so the card cannot recommend Ship over it.
- **ship** lands the change the project's way and prints one line saying what
  is true now: live, or waiting on a deploy and where. A refusal says why on
  stderr, which the station puts on the task. Exit 3 means the default branch
  moved past the branch after the rebase station, and the run rebases again
  (three rebases at most). Without one the ship
  station runs Ship (docs/architecture/ship.md), which opens the pull request
  and merges in either of two cases: the profile sets `[line.merge] auto`, or
  the role that owns the line holds a merge grant (`org_roles.line_merge` with
  its merge authority, the-line.md L12). A grant merges through `cast line
  merge`, so it counts against the role's daily limit.

## LP5. Principles and prompting per project

Principles are split three ways. The shared set ships with codecast
(`docs/principles.md`, the ones the evidence shows in more than one project,
in project-neutral language). A project's own set lives in its repo at the
path its profile names: codecast's is `docs/line/principles.md` (`CC-` ids),
Union's `outreach/docs/line/principles.md` (`UN-` ids). A project file holds
what is true only there and the concrete form a shared principle takes in
that project. Every reader takes both, shared first: `cast goals` reads the
shared set from the copy built into the CLI and the profile's files from the
repo, and the plan, implement and review nodes receive the shared set's
public link with the profile's paths (`$line.principles`). Reviews cite ids.
The weekly lessons run is per project: it mines that
project's sessions and files `lesson:<id>` signals into that project.

## LP6. Who answers

A card goes to the person the owning role reports to, unless the cause is in a
protected category, where it goes to the workspace owner. A person may hold any
number of open cards: unanswered cards never hold back a start, and
`caps.cards` limits nothing. What a line starts is bounded by the runs working
on its runner's machine (the-line-end-to-end.md LE6). A station can take fewer
at once than the line runs: `[line.caps.stations]` names each such station by
its id and how many of the team's running runs it takes together. Before the
station starts, the runner asks the server for a place
(`workflow_runs.admitToStation`), counted over the workspace's running runs in
one transaction. A run refused waits outside the station with its clock not
started. Union's Eval needs this because its proofs share one eval host:
queued inside Eval's clock, they were killed mid-draw (ct-68695, 2026-10-29).
A CLI older than the key refuses the whole profile, so a project adds the
table only once every machine running its line has a CLI that reads it.
Operational asks (a call
to make, a document to send) are not change cards; a recurring class of them
is a signal.

## LP7. Shipping a default

The default line that ships with codecast is an org template: one role that
owns a project's line, routines that are its finders, the shipped `line`
workflow, and the shared principles. A project's profile overrides any
default.

The release lives in this repository at `packages/cli/org-templates/line/`
and installs like any other (org-templates.md):

```sh
cast org template install packages/cli/org-templates/line --instance <name> \
  --project <exact-project-id> --team <team-id> --dir <checkout>
```

- **The role** is the Line lead (`<instance>-line`), scoped to exactly the
  instance project. Its charter gives it four jobs: ground the causes the
  ground sweep could not place (LE5) from the project's goals and the evidence
  on the cause; keep the queue worth admitting and never route around
  admission (LE6); keep the declared finders honest (LP3); and answer nothing
  on the line. Cards go to the person it reports to, protected causes to the
  workspace owner (LP6), and profile, principle and repository changes are
  proposals a person accepts.
- **`role.line` and `role.caps.cards`** are the manifest's line fields (v2
  only). The install copies both into the role proposal, so the person
  approves the workflow and the cap with the role, and the sentence they read
  says both. Applying the answer sets `org_roles.line_workflow_slug` and
  `caps.cards` under that human decision (`applyRole` in `orgInit.ts`), and
  reconcile refuses to provision a role that does not carry what was
  approved. A manifest without `role.line` leaves the role on the default,
  the shipped `line`. An upgrade cannot change either; that is a separate org
  decision, as for the other caps.
- **Three routines, all created paused and gated** like every template
  routine. `lessons-weekly` runs the cast-lessons skill over the project's
  sessions and files `lesson:<rule>` signals into it (LP5).
  `finder-health` reads the profile's finders and each one's newest signal
  daily, and files one `org_health` signal per silent finder under
  `finder-silent:<finder id>`, so every day of one silence counts toward one
  cause. A finder is silent past the input `finders.silent_days` (default 3),
  or past one interval of its own schedule when it runs less often. It
  requires the evidence check `profile`.
  `expectations-daily` reads the team's context since the expectations
  cursor (decisions, tasks, calls, chat) and proposes changes to the
  project's expectations, each quoting its source (the-line-model.md LM5).
- **The starter profile.** The role's one setup item reads the repository's
  `.codecast/line.toml`. When there is none it shows the person the output of
  `cast line profile --starter --project <name>` (the defaults of LP2 written
  out, the project filled in, optional commands and a finder as comments) and
  writes it with `--write` only on their yes; `--write` refuses when a profile
  exists. Then `cast line profile --publish` declares the finders and the role
  records `profile`, which unlocks `finder-health`.

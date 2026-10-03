# The line profile: one line per project

`the-line-end-to-end.md` describes the graph every change follows. This
document says what differs per project and where a project declares it. The
graph, the card, the gate and the stack are the same everywhere. What a
project owns is its own answer to six questions: what do we listen to, what
are we trying to move, what do we hold work to, how do we check a change, how
do we prove and evaluate one, and who answers the card. Sections are numbered
LP1 onward.

## LP1. Project is the unit

A line belongs to a project (a codecast `projects` row), not to a workspace.
A team with eight projects has up to eight lines, each with its own signals,
causes, goals, cards and throughput.

- A signal carries `project_id`. A cause is a task, and its `project_id` is
  the signal's. Fingerprint attach and the attach judge look only inside the
  project.
- `cast signal add` takes `--project <ref>`. Without it the project comes
  from the repo's profile (`[line] project`), and a finder that serves several
  projects names one per signal.
- `cast goals --project <ref>` renders that project's charter and the
  initiatives that carry it. The ground node passes the run's project.
- `/line` shows one project at a time, with a switcher, and an "all projects"
  roll-up that only counts.
- Admission is per role (the-line.md L9), and a role's scope names projects,
  so a cause with a project is seen by the role that owns it. The cards cap is
  counted per person across all their lines (LP6).

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
cards = 5                            # open cards per person, across their lines

[[line.finders]]                     # what this project listens to (LP3)
id = "invariants"
source = "union.invariant"
kind = "regression"
fingerprint = "union:invariant:<id>"
runs = "backend job captureInvariantSnapshots"
project = "Infrastructure"
```

`cast line profile [--json]` prints the resolved profile for the current
directory. The runner loads it once per run and exposes every value as a
variable (`$line.commands.check`, `$line.principles`, `$line.size_budget`), so
the shipped template names no repository path and no tool of codecast's own.
A repo without a profile gets the defaults: `cast ws check`, no prove or eval
command (the stations pass with a note saying so), codecast's prompting
standard, no principles file.

## LP3. Finders are declared

A finder is whatever writes signals for the project: a backend job, a trigger,
a routine of the role that owns the line, a person. The profile lists them so
the line page can show each one with its last signal and say honestly when a
finder is silent. A finder types its own signals (LE3) and computes a
fingerprint that is stable across rewording. The profile entry is a
declaration; the finder itself lives where its data lives.

## LP4. Project commands, one contract each

- **check** exits 0 when the branch is sound. It is the verify station.
- **prove** exits 0 only when the miss is shown: every miss moment fails on
  the base and every guard passes. It writes `$run_dir/proven.json`.
- **eval** writes `$run_dir/reps.json`: per surface, per freeze, per side
  (base, branch), the reps with `passed`, `score`, `reply`, `judge_note` and
  `cost_usd`, plus `gates_failed`. It does no statistics.
- `cast line eval-result --reps $run_dir/reps.json --out eval-result.json`
  turns reps into the `EvalResult` the card reads: separation by the one
  Mann-Whitney implementation (`packages/evals/src/stats.ts`), flips, proven
  freezes, the verdict. Its exit code is the eval station's.
- **ship** lands the change the project's way and prints one line saying what
  is true now: live, or waiting on a deploy and where.

## LP5. Principles and prompting per project

Principles are split three ways. The shared set ships with codecast
(`docs/principles.md`, the ones the evidence shows in every project). A
project's own set lives in its repo at the path its profile names. The review
node reads both and cites ids; a project id is prefixed with the project
(`UN-prompt-2`). The weekly lessons run is per project: it mines that
project's sessions and files `lesson:<id>` signals into that project.

## LP6. Who answers

A card goes to the person the owning role reports to, unless the cause is in a
protected category, where it goes to the workspace owner. `caps.cards` counts a
person's open cards across every line they answer for, so nine roles do not
mean forty-five open cards. Operational asks (a call to make, a document to
send) are not change cards and never count against the cap; a recurring class
of them is a signal.

## LP7. Shipping a default

The default line that ships with codecast is an org template: one role that
owns a project's line, routines that are its finders, the shipped `line`
workflow, and the shared principles. `role.line` and `caps.cards` join the
manifest. A project's profile overrides any default.

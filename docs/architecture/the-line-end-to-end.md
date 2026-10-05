# The line, end to end: from a signal in the world to a shipped, watched change

`the-line.md` defines how one task moves along a role's line: stations, gates,
holds, evidence, runs. This document extends the line in both directions so
that every change we make, to code or to a prompt, follows one graph:

```
sense → attach → ground → admit → [plan gate] → prove → build → verify
      → eval → review → card → decide gate → ship → watch → learn
```

![The line end to end: finders write through signals.ingest into causes, lineGround.sweep grounds them, cast workflow run starts one line.cast run (ground through card), the card becomes a decide gate the person answers, Ship lands the change and watches the cause, and a Revise or Drop note becomes a lesson signal](../diagrams/the-line-end-to-end.svg)

The front half turns what the world tells us (errors, eval drift, judge
findings, people's complaints, our own corrections) into a small number of
causes, each tied to a goal. The back half turns a cause into one change with
proof, and asks a person one question about it. Nothing here adds a third
engine, a second decision rail or a second evidence model: every stage is a
node in the DOT engine (`packages/cli/src/workflow/`), every question is a
`session_decisions` row, every artifact attaches to the task. Sections are
numbered LE1 onward so code can cite them.

## LE1. Principles

1. **Code decides what code can check.** Git, checks, eval verdicts, dedupe by
   fingerprint, admission and routing are deterministic. A model is asked only
   what needs judgment, one decision per call.
2. **Atomic nodes.** A node does one thing, reads a declared input, writes a
   declared output, and can be replayed on its own. A prompt that makes two
   decisions is two nodes.
3. **The person is the drum.** Work is admitted at the rate decisions are
   answered. More agent throughput than that only adds waiting and rubber
   stamping.
4. **One cause, one run.** Signals attach to a cause. A cause has at most one
   live run. Siblings are visible to it.
5. **Proof before the fix.** A change starts by showing the miss: a failing
   test, or an eval that fails on the base. It ends by showing the same check
   passing, with examples.
6. **One card shape.** Code fixes, prompt changes, UX changes and escalations
   end in the same change card (LE10). The PR is evidence on the card, not the
   review unit.
7. **A click is a wire.** Answering a gate resumes the run that asked. No
   decision travels as text through a session, a comment or a regex.
8. **Fix behavior in the prompt.** A prompt miss is fixed by rewriting the
   instruction that causes it, proven by evals (LE8), never by a filter.
9. **Every stage shows its state.** A stage that is paused, starved or failing
   says so, and since when, on the line page (LE13).

## LE2. Words

The line's nine words (the-line.md L1) stand. This document adds four.

| Word | Meaning | Home |
|---|---|---|
| signal | one observation from the world, typed at its source | `signals` |
| cause | a task that signals attach to; the unit of work on the line | `tasks` with `cause` fields |
| card | the fixed-shape summary of one change and its proof (LE10) | `shared/contracts/changeCard.ts`, published page on the task |
| watch | the period after ship when the cause's signals are counted again | `tasks.watch_until` |

## LE3. Sense: signals are typed at the source

A finder is anything that observes the world: Sentry, PostHog, the eval
nightly, AgentWatch judges, session insights, cast-lessons, org health, issue
sync, a person typing `cast signal add`. Every finder writes through one door,
`signals.ingest` (CLI `cast signal add`), and types what it saw itself. Nothing
classifies free text afterwards.

```
signals {
  workspace, team_id                 access and routing, as tasks (CLAUDE.md)
  source        "sentry" | "posthog" | "evals" | "agentwatch" | "insight" | "lesson"
                | "org_health" | "issue" | "person" | string
  kind          "bug" | "regression" | "prompt_miss" | "ux" | "cohesion" | "request"
  fingerprint   stable key the finder computes (error group, eval surface+check,
                cluster id); the dedupe key
  title         one line, the finder's words
  detail_md     the observation, bounded
  evidence_url  where a person can see it
  subject       optional: the file, surface, prompt id or route it concerns
  goal_hint     optional: the initiative metric key the finder believes it threatens
  observed_at, created_at
  task_id       the cause it attached to (LE4)
  attach        "fingerprint" | "judge" | "new" | "person"
}
```

A finder is a trigger or a cron that calls the door. It is not a node on the
line: the line starts at attach.

## LE4. Attach: one cause per problem

`signals.ingest` attaches in order and records how:

1. **Fingerprint.** An open cause already holding a signal with the same
   `fingerprint` takes it. Deterministic.
2. **Judge.** Otherwise the five closest open causes (text match on title and
   subject) go to one small call: "same cause as one of these, or none?". It
   answers with a task id, `none`, or `unsure`. `unsure` is `none`.
3. **New.** Otherwise a new cause: a task with `source: "signal"`,
   `triage_status: "suggested"`, the signal's title, and `cause` fields
   (`signal_count`, `first_seen`, `last_seen`, `fingerprints[]`).

A cause that receives a signal while in `watch` (LE12) reopens.

## LE5. Ground: every cause names the goal it serves

`cast goals --brief` renders the workspace's goals as one compact document:
active initiatives with their metrics (target, latest scoreboard value, when),
each project's charter (goal, success metrics, non-goals, priority), and the
standing principles (the shared set that ships with the CLI, then the files
the project's line profile names, LP5). The ground
node reads that and the cause with its signals, and writes four fields:

- `goal_ref`: the initiative metric or project goal the cause threatens, or
  `none`. A cause with `none` parks as `suggested` and never reaches a person
  unless its signal count crosses the workspace threshold.
- `category`: `code` | `prompt` | `ux` | `infra` | `data`.
- `risk`: `low` | `review` | `plan`. `plan` means architecture, cross cutting
  design, schema, billing or anything in the protected decision categories:
  the run stops at a plan gate before build.
- `readiness`: `ready` | `needs_context` | `not_actionable`, with one line why.

Priority is computed, not judged: goal priority × severity × signal count,
in `lib/linePriority.ts`.

A fresh cause is grounded before admission, so admission can rank it and
spends a hand only on causes worth one. `lineGround.sweep` takes the oldest
open causes with no `readiness` and no run, and makes one model call each over
the cause, its signals and latest comments, and the goals brief of its project
(of its workspace when it names none). The meaning of each field has one home,
`GROUND_FIELDS` in `shared/contracts/goalsBrief.ts`, which the ground node's
prompt carries verbatim. A reply it cannot use (a goal_ref the brief does not
offer, a value outside the vocabulary) leaves the cause `needs_context` with
the reason, for a person; no reply at all leaves it for the next pass.

## LE6. Admit: work starts at the rate decisions finish

The admission sweep is off: `crons.ts` does not register `orgLine.sweep`
(since 2026-10-02), so a run starts when someone runs `cast workflow run
--task <ct-N>` (no file: the calling role's line, else the shipped `line`).
The rule below is what `orgLine.sweep` and `orgLine.queue` compute.

`orgLine.sweep` (the-line.md L9) admits causes, highest priority first, while
both hold:

- the open cards of the person the role reports to (the top of its chain),
  counted across every line they answer for, are fewer than the smallest
  `caps.cards` among their live line roles (default 5; line-profile.md LP6),
  and
- `counters.hands < caps.hands_per_day`.

When the person answers a card, a slot frees and the next cause starts. A
cause that waits shows "queued behind 5 open cards" on the line page.

An open card is a pending, blocking `session_decisions` row of the role's
host, asked at gate node `decide` (`LINE_CARD_GATE_NODE`) of a run the role's
standing session spawned. Candidates are the role's assigned tasks plus causes
(`source: "signal"`, `readiness: "ready"`, `goal_ref` set, unassigned) it owns.
`orgLine.queue` returns the candidates in admission order with why each waits;
`cast role limits <handle> --cards <n>` sets the cap.

## LE7. Plan (only when `risk = plan`)

An agent writes a short plan to the task (the approach, the files, what will
be proven red, the size budget) and the run pauses on a plan gate: Approve,
Revise (with a note, back to plan), Drop. Scope is frozen at the gate; new
information during build sends the run back here instead of steering build.

## LE8. Prove, build, verify, eval

**Prove.** Before any fix, the run shows the miss:

- `code` / `ux` / `infra`: a failing test or a reproduction script, committed
  on the branch, its failing output kept as evidence.
- `prompt`: the signals' moments become the misses, each with a judge
  sentence stating the expected behavior, plus a few guards the prompt already
  gets right. The project's prove command (line-profile.md LP4) must exit 0 on
  the base: every miss fails and every guard passes. It writes
  `$run_dir/proven.json`, the **before** set. codecast's runs the freezes
  through `./evals freeze replay` (`scripts/line.ts prove`).

A miss that cannot be reproduced closes the cause as `dissolved` with the
evidence; it is a success, not a failure.

**Build.** One change, in the worktree, within the profile's size budget
(400 changed lines by default; more splits or returns to plan). Prompt changes
follow the profile's prompting standard (codecast's `docs/prompting.md` by
default).

**Verify.** The profile's check command in the worktree (`cast ws check` by
default). Two failed rounds stop the run with a decision to the owner.

**Eval.** The profile's eval command picks the surfaces the branch owes,
replays them on the base and on the branch, and writes `$run_dir/reps.json`;
`cast line eval-result` turns the reps into `eval-result.json` and its exit
code is the station's. It passes only when the proven freezes now pass, no
gate fails, nothing crashed, and no surface is `separated: worse`. The result
carries the **after** set and the flipped examples (before reply, after reply,
judge note). A project with no eval command passes the station with a note on
the task.

## LE9. Review: the diff against the intent

A fresh session on a different model family from the builder reads only the
task, the card draft and the diff, and answers four questions, each pass or
fail with a line of reason: does the diff do what the cause needs; does it do
anything else (scope creep); does it reuse what exists instead of adding a
parallel path; does it follow the repository's standards (CLAUDE.md). One
fail is `changes`.

## LE10. The card

Every run ends in one card, whatever the category. The contract lives in
`packages/shared/contracts/changeCard.ts`; one renderer turns it into the HTML
page attached to the task and shown inline in the decision.

```
ChangeCard {
  cause:     { task, title, signals: count, first_seen, sources[] }
  goal:      { ref, name, why }                  from ground
  wrong:     one or two sentences: what is wrong, in the user's terms
  change:    one or two sentences: what behaves differently after this
  proof:     { before: Check[], after: Check[] } red then green
  examples:  [{ input, before, after, note }]    at most three, prompts and UX
  checks:    [{ name, ok, detail }]              verify, eval, review
  diff:      { files, added, removed, pr? }
  risk:      { class, reason }
  recommend: "ship" | "revise" | "drop", one sentence why
  cost:      { tokens, usd, minutes }
}
```

Only `wrong`, `change` and `recommend` are written by a model, in one call that
reads the rest. Everything else is assembled from what the nodes recorded.

## LE11. Decide

The card becomes a blocking gate decision bound to the task and run (the-line.md
L4), with the card as its report and three options: Ship, Revise (a note goes
back to build), Drop (close with the reason). Cards for one line on one day
share a stack (`stack="Line · <role> · <date>"`), so the person clears them in
one sitting. The answer patches the run through `finalizeAnswer`; nothing is
relayed by a session.

## LE12. Ship, watch, learn

**Ship.** The profile's ship command lands the change the project's way and
prints one line saying what is true now, which goes on the task. A project
with none lands it through the merge station (the-line.md L12, `cast line
merge`). A prompt surface change records the eval run set as the new baseline.

**Watch.** The cause enters `watch` for the profile's `watch_days` (default 7):
`tasks.watch_until`. A signal with one of its fingerprints during watch
reopens it with the signal attached. A watch that ends quiet closes the cause
as `resolved`. `cast task update --watch-days N` sets the watch (0 ends it);
the hourly `signals.sweepWatches` closes quiet ones as done with a note naming
the quiet window.

**Learn.** A Revise or Drop answer with a note proposes a countermeasure as its
own small signal (`source: "lesson"`, `kind: "cohesion"`): an instruction line,
a lint rule, or a structural test that would have prevented it. The answered
gate is written to the recorded decisions log with its rationale.
Both happen in `lineLearn.ts`, called from the one settle path every answer
takes (`sessionDecisions.settleResolution`); the card gate is the gate node
`decide` (`CARD_GATE_NODE_ID`), and the lesson's fingerprint is
`lesson:<task>:<hash of the note>`.

## LE13. The line page

`/line` shows the whole factory as one horizontal flow, live from the store:

- **Columns** for sense, causes, in build, awaiting you, watching, closed this
  week, with counts and the oldest item's age.
- **Stage state** on every column: running, paused (and since when, and why),
  starved, or failing (last error).
- **Awaiting you** is the card stack itself: each card renders natively with
  its proof strip (red then green), examples and the three answers, keyboard
  first.
- **Throughput** for the week: signals in, causes opened, dissolved, shipped,
  reopened in watch, median time from signal to ship, cost per shipped change.

## LE14. Iterating on the line itself

A line is a versioned workflow: each run records the graph's content hash, so
a change to a node prompt or an edge can be compared by its outcomes (ship
rate, revise rate, reopened in watch, cost). A change to a node prompt is
itself a prompt change and goes through LE8 against freezes of that node's
past inputs.

## LE15. Other systems on the line

AgentWatch (union-mobile) becomes a finder and a set of node prompts. Its
judges write signals with the cluster id as fingerprint; its arc splits into
the prove, build and card nodes; its decisions become gates whose answers
reach the planner through the run, not a parsed comment. The desk's prompt
change chain and the broker's typed asks use the same card and the same gate.

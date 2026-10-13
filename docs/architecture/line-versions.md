# Line versions: what an iteration leaves behind

A line is changed all the time: a prompt is rewritten, a station is added or
removed, a gate is renamed, a judge or extractor is republished, an
expectation gets a new version, findings are regrouped. Each change leaves
work that was made for the line as it was. This doc says how that work leaves
everyone's view by itself, without anyone picking it out and without anything
being lost. Sections are LV1 onward.

## LV1. One rule: superseded

Every artifact of a line is either **current** or **superseded**. Superseded
means a later fact has replaced it: newer work on the same thing, or the
thing it was made for is gone. It is decided by one pure predicate per kind
over facts the record already holds, never by a flag a person or a sweep
sets, and never item by item.

| Artifact | Superseded when | Replaced by |
|---|---|---|
| Problem (cause task) | it was merged into another (`cause.merged_into`); or it is open, once held findings (`cause.last_seen`), and holds none now (`cause.signal_count` 0) | the survivor, or nothing |
| Run (live only) | a later run exists on the same problem; or its problem is superseded or closed; or it stands at a station its line's graph no longer has; or it waits at a gate the line has changed since (below) | the newer run, the problem's next run, or the line's newer version |
| Card or decision a run's gate asks | its run or its problem is superseded; or its run has left that gate; or it declares what it covers (`reach.covers`) and none of the problem's live findings is among them | its run's or problem's replacement |
| Finding | it does not stand as evidence (`retired`, `merged_into`, `case_of`, `judge_review`); or its judge is no longer published | the finding it merged into, or nothing |

**Iterating the line supersedes what it waits on.** A run waiting at a gate
is superseded ("line changed", by the version) when the line's published
graph has moved past what made that gate: the gate is no longer a person's
gate there, or the station that presents it (its `asker`) has a different
hash than the run recorded, which also covers a gate asked with no presenting
session where the line now has one. A change to the gate's own wording or to
any other station leaves it current. The run's hashes are the `graph_nodes` it recorded, else
the version published when it started; the line's are its newest saved
version (`workflow_versions`), or the hashes its newest run recorded when that
run is newer, since every run pushes the graph before it starts (the shipped
line is pushed from no file, so it has no saved versions). Nothing is written:
the comparison is made at read time (`gateOutdated`, `gateLineChange` in
`convex/lib/superseded.ts`), and unknown hashes hide nothing.

A card or run carries the root reason, not a wrapper: a card whose run waits
at a removed gate reads "station removed", one whose problem lost every
finding reads "its findings moved".

Some things are never superseded, because they are history: a finished run
(a later run that failed does not hide the one that shipped), an answered
card, a closed problem. A problem that never held a finding (filed by a
person, grounded from a request) is current. A card that declares no
coverage is never hidden by coverage. A finding filed by an older version of
a judge that is still published is current: the judge's new version reads
its moment again and settles it (learning-loop.md LL8), and hiding it first
would empty problems that version has not read yet.

The predicates live in one module, `packages/shared/contracts/superseded.ts`
(`supersededProblem`, `supersededRun`, `supersededCard`, `supersededFinding`,
`problemFactsOf`, `currentOnly`), each returning `null` or `{ why, by }`, so
the server and every client decide with the same code, as `isRunLog` does
for run logs. `convex/lib/superseded.ts` gathers a run's, problem's or
decision's facts from the database for them.

## LV2. Applied where things are read

A superseded artifact is hidden by default from every list, count and queue,
and still opens from its own link. The rule is applied at the read
chokepoints, not at each surface:

- **Rows say it.** Every run feed (`workflow_runs.enrichRun`), the trial's
  cards and runs (`lineTrial.cards`, `lineTrial.runs`) and a decision's page
  (`sessionDecisions.getWithDoc`) carry `superseded: { why, by } | null`.
- **Decision reads filter.** The queue (`listForUserCore`, and through it the
  CLI), a role's queue and its brief count (`pendingOnLadder`) and the stacks
  (`decisionStacks` `listRow`, `getStackCore`) pass their rows through
  `currentDecisions`, so every count derived from them follows. `get` and
  `getWithDoc` stay unfiltered.
- **Client readers filter.** `useTrialCards()`, `useTrialRuns()` and
  `useWorkspaceRuns()` return current rows; a history reader (a problem's
  attempts, a run's or a decision's own page) asks for `{ all: true }`.
- **Session lists** already hide station sessions and run logs
  (`is_workflow_sub`, `isRunLog`).
- **The CLI** hides superseded cards in `cast line trial`; `--all` shows them.

`web/lib/__tests__/supersededReaders.guard.test.ts` fails a web file that
reads the trial store keys around the hooks, a hook that stops filtering, a
decision read that drops `currentDecisions`, and trial queries that stop
saying which rows are superseded.

## LV3. History on purpose

A list that hides something offers it back as one control with its count:
/trial's **Superseded** tab lists them dimmed, each with "Replaced · why" and
a link to what replaced it. A superseded artifact's own page opens normally
with the same line at the top (`components/SupersededNote.tsx`, used by the
trial pane and the decision banner in `DecisionAnswering.tsx`). Nothing is
deleted.

## LV4. Versions stay honest

The rule reads facts, so those facts must be true:

- A run reports the graph it is on now (`graph_hash`, `graph_nodes`) on every
  start and every resume, not only the graph it started on.
- A command station marked `refresh=true` renders the line's own text
  (Union's `shared` node reads `_shared.md`); a resumed run makes it again
  before going on (`runner.ts refreshedOnResume`), so it reads today's text,
  never the copy in its checkpoint.

## LV5. What it replaces

- `stale_gate`, `regrouped`, `evidence.findings === 0` and `superseded_by` on
  trial cards stop being things each surface interprets; they are inputs the
  card predicate reads.
- The "Nothing left" and "Held" debris lanes on /trial empty out: what they
  held is superseded and leaves by itself.
- `/tmp/trialfix-refresh.py` and `rerun --reask` for stale shared text are
  `refresh=true`.
- `cast line trial sweep` (ending runs on closed problems) becomes the run
  predicate once the dispatcher reads it; until then the dispatcher is
  unchanged, so no hidden run starts new work by itself.

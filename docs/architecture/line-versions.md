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
| Problem (cause task) | it was merged into another (`cause.merged_into`, `duplicate_of`), or it is open and holds no live finding | the survivor, or nothing |
| Run | a later run exists on the same problem; or it waits at a station the line no longer has; or its problem is superseded or closed while it waits | the newer run, or the problem's next run |
| Card or decision of a run | its run is superseded; or its run has moved past the gate it asks at; or none of the problem's live findings is one the card covers (`coverage`: every finding it was built on moved or was withdrawn) | the run's newer card, or the survivor's |
| Finding | it does not stand as evidence (`retired`, `merged_into`, `case_of`, ruled wrong); or its judge is no longer published (`judges.removed_at`) | the finding it merged into, or nothing |
| Station session | its run is superseded | the newer run's session |

A finding filed by an older version of a judge that is still published stays
current: the judge's new version reads its moment again and settles it
(learning-loop.md LL8), and hiding it first would empty problems the new
version has not yet read. Work that finished (a shipped run, an answered
card, a closed problem) is history, not superseded: it shows where history
shows.

The predicates live in one module, `packages/shared/contracts/superseded.ts`,
each returning `null` or `{ by, why }` (`by` is the replacing thing's short id
when there is one, `why` a short reason), so server and client decide with the
same code, as `isRunLog` does for run logs.

## LV2. Applied where things are read

A superseded artifact is hidden by default from every list, count and queue,
and still opens from its own link. The rule is applied at the read
chokepoints, not at each surface:

- **Server queries** that list or count line work (the decision queue and its
  counts, `lineTrial.cards`, the trial dispatcher, the line's runs, a task's
  runs and decisions, CLI reads) filter with the predicates before they
  return.
- **Client readers** of the store (`/line` lists and counts, the Inbox, task
  pages, `/trial`) read through one selector that applies the same
  predicates, so a store row the server sent for history does not leak into a
  default list.
- **Session lists** already hide station sessions and run logs
  (`is_workflow_sub`, `isRunLog`); nothing more is needed there.
- **The dispatcher** treats a superseded run as ended, so its problem is due
  again by the rules it already has.

A source-level guard test fails a reader of runs, trial cards or line
decisions that does not go through the chokepoint, the way the feed guard
works for the store.

## LV3. History on purpose

Each list that hides something shows how many it hid as one control,
"N superseded", which brings them back in place, dimmed, each naming what
replaced it. A superseded artifact's own page opens normally, with one line
at the top naming its replacement and linking to it. The CLI hides them too;
`--all` shows them. Nothing is deleted.

## LV4. Versions stay honest

The rule reads facts, so those facts must be true:

- A run records the graph it is on now, not only the one it started on: a
  resume that reads a newer graph updates `graph_hash` and `graph_nodes`.
- A station that renders the line's own text (Union's `shared` node, which
  reads `_shared.md`) is re-made on every resume, so a resumed run reads
  today's text, not the copy in its checkpoint.
- A run that waits at a station the graph no longer has continues from the
  last station it made that the graph still has, by that station's outcome
  over the graph's current edges, rather than standing forever on a gate no
  one can answer.

## LV5. What it replaces

The rule replaces the one-off fixes each iteration needed:

- `stale_gate`, `regrouped`, `evidence.findings === 0` and `supersedeMerged`
  on trial cards become inputs to the card predicate rather than flags each
  surface reads;
- `cast line trial sweep` (ending runs on closed problems) is the run
  predicate plus the dispatcher reading it;
- `cast line trial rerun --reask` and `restart` for a stale station, and
  `/tmp/trialfix-refresh.py`, are LV4's resume rules;
- `*.before-*` copies of prompts and graphs are not needed: every published
  graph is a `workflow_versions` row, and the line's files live in git.

Reclaiming disk (run worktrees and run directories of superseded runs) reads
the same predicate; it removes a worktree only after committing what it holds
to its branch, so the branch keeps everything.

# The line: the model

How the line fits the rest of codecast, in one place. The other line docs
(`the-line.md`, `the-line-end-to-end.md`, `line-profile.md`) specify parts;
this one says what the parts are and how they relate. Sections are LM1 onward.

## LM1. One line per project

A line is a project's way of changing itself: what it listens to, what it is
trying to move, what it expects to see, what it holds work to, how it proves
and ships a change, and who answers. The project is the unit because goals,
expectations, owners and feedback all belong to a project.

- A team has as many lines as it has projects. Union's eight projects are
  eight lines; they share one repo and so one set of commands, and differ in
  their sources, goals, expectations and owners.
- A project has exactly one line. Different kinds of change (a prompt, code,
  a UX fix) are branches inside the one graph, chosen by the cause's category,
  so each project tells one story and its versions can be compared.
- The team has a default line; a project uses it until it forks its own.

## LM2. Objects, each with one home

| Object | What it is | Home |
|---|---|---|
| Expectation | how the project should behave, with the sources it came from | the project's expectations doc (LM5) |
| Signal | one observation from the world, typed where it was seen | `signals` |
| Cause | a problem the line will fix: signals that share a root | a task (`source: signal`) |
| Run | one pass of a cause through the line | `workflow_runs` |
| Card | one change and its proof, put to a person | a decision (`session_decisions.card`) |
| Ship | the change landing, the project's way | the run's ship record |
| Watch | the days after ship when the cause's signals are counted again | the task's `watch_until` |

Nothing the line knows lives in a second place. Every surface reads these
homes.

## LM3. Where a cause is, and its task status

The run is the truth of where work is. A cause's task status is the line's
plain summary of it, written only by the line, only through the one task
status path (so it has history and notifies like a person's change):

| Where the work is | Task status | Also shown |
|---|---|---|
| waiting to be admitted | open | its place in the queue |
| a run is building it | in progress | the station it is at |
| a card waits on a person | in review | who holds the card |
| shipped | done | "watching until <day>" |
| its signal came back during the watch | open | "reopened" |
| a person dropped it | dropped | the reason |

A person's own status change wins: dropping a cause stops its run, and the
line never writes over a status a person set.

## LM4. Who runs it, who answers

The line runs without roles: a person starts a run from a cause. A role whose
scope holds the project adds autonomy: its sweep admits causes in priority
order, within its caps, so the work flows without anyone pressing start. The
card goes to the person who answers for the project (the role's person, or the
project owner), capped per person across every line they answer for.

## LM5. Grounding: goals rank, expectations detect

Two kinds of context, used at two different moments.

- **Goals** say what the project is trying to move (initiatives, metrics,
  charters). The ground step reads them to rank causes: which goal does this
  threaten, how much.
- **Expectations** say how the system should behave: what a good reply to a
  broker looks like, when an intro should go out, what a caller should see.
  A finder that judges behavior (an AgentWatch judge, a call grader) compares
  what happened with the expectations; the difference is the finding, and it
  cites the expectation it breaks. The finder files that line's id as the
  signal's subject (LE3), which is where the cause's story reads the
  expectation it breaks; the words come from the line's own document
  (`expectations.lines`), and the id opens it on the project's Line tab.

Not every finder is grounded in expectations. A finder that judges behavior
is; a finder that watches a number or a check is grounded in that metric, and
its signal's subject names the metric, guard or scenario instead of an
expectation. On Union's line the AgentWatch judges (comms, match, call_eval),
filed through the clusters finder, are expectation-grounded, and their cause
belongs to the project holding the expectation the top finding cites, else
Agent Quality. Guards, replies, eval reds and goal drift are metric-grounded.
The rest file from events (invariants, errors, desk edits, escalations, a
person's report) and cite neither.

A project's expectations are one living document, each expectation stated
plainly with the sources it came from (a call, a chat thread, a session, a
task, a decision). A routine reads the team's new context every day and
proposes additions and changes, each with its sources, so the expectations
follow what the team actually says. A judge reads the expectations version it
graded against, so a finding can always be traced to the expectation and the
words behind it.

The document is versioned rows in `project_expectations` (one per version,
never rewritten), changed only by proposals in `expectation_proposals`
(`xp-N`): additions, edits and retirements, each citing its sources (kind,
ref, quote, when). Lines carry stable ids, `ex-<project>-<n>`, active or
retired. A proposal applies on its own when it only adds lines and each line
quotes, with its date, words the record shows a person said: a chat line they
typed, a decision they answered, what they said on a call (the server checks
the quote against that record), and the line shares at least two claim words
with that quote (`followsFromQuote`). The shared words are a floor: they stop
an invented line from riding in on an unrelated real quote, and they cannot
tell a faithful line from one that reuses the quote's words to say something
else, so every version records how it applied (`how: "auto"` or `"person"`)
and a person can retire any line of it. Any other change waits for the project's
person, as a card in their queue whose Apply lands it. `cast expectations show|propose|apply|drop`
is the CLI; `/cli/expectations/brief` is what a judge reads (the active lines
with ids under the version to cite). The line template's
`expectations-daily` routine is the proposer; its cursor is the newest window
a proposal recorded, and a proposal an operator retracts (one that should never
have run) records none. Shapes and the parser: `shared/contracts/expectations.ts`.

## LM6. Changing the line

The line's definition is its profile, its graph and its station prompts. It
lives in the project's repo (`.codecast/line.toml` and `.codecast/line/`),
versioned with the code, and is mirrored to the app so anyone can read it on
the project's line map (line-map.md LX5). Editing a value on the map writes the
change to the repo through the machine that published it, which checks it and
republishes; a station's prompts are written out from the shipped line on the
first change and removed again when a reset brings every station back to
shipped. Every run records which version it ran, so the Line tab shows what
each version delivered (runs, shipped, revised, dropped, stopped, reopened,
cost), and each station's panel shows the versions in which that station
changed. A change to a station prompt is a prompt change like any other: the
editor offers to send it through the line, where eval scores it before and
after when the project has an eval command, and the card says it is unscored
when it has none. Anyone can also ask an agent for a change to any part of the
line from the map; that files a cause in category `line` and the line runs it
like any other change (LX6).

Whether the line starts work on its own, and how many cards it may hold open
at once, belong to the role whose area holds the project, not to the profile.
Both are shown and edited where the queue is, on the Causes panel.

## LM7. Where people see it

The line shows up wherever its objects already appear, never only on a page of
its own:

- the task page tells a cause's story (signals, goal, expectation broken,
  where it is, the card, every run) and links to its trace;
- task lists and boards show the status and the watch;
- the decision queue holds the cards, and each card links to its cause's trace;
- notifications reach the right person when a card waits, a change ships, or
  a watched cause reopens;
- the run page reports one run and links to the trace;
- the project page's Line tab leads with the project's line map (its flow and
  data, a panel per node where every value is read and edited, and the
  composer), then its expectations and its versions;
- `/line` shows the same map for one project at a time, with a switcher across
  the team's lines and a roll-up that counts every line;
- `/line/trace/<ref>` follows one thing (a signal, a fingerprint, a cause, a
  run or a card) from where it was seen to its outcome.

## LM8. The working view, "done", and the measure

A judge's output is a stream of findings: one per subject per judgment, so
their count tracks traffic, not quality, and never shrinks to a working list.
The working view of quality is therefore the project's causes, not its
findings or the clusters that group them.

- **Findings are signals.** A judge's finding cites the expectation it breaks
  as the signal's subject (LM5) and carries its evidence. Clusters group
  findings that look alike; they are the finder's fingerprint, not a list
  anyone works.
- **Causes are the working view.** A cause is one root mechanism, with every
  signal it explains attached, the expectation it breaks, the goal it
  threatens, and its place on the line. This is the list people read and the
  line drains.
- **A cause is done** when its fix has shipped and its watch has ended with
  no signal of its own coming back (LE12). A cause whose miss does not
  reproduce at prove closes as dissolved at the dissolve station
  (`line/dissolve.sh`).
- **A judge's mistake becomes a freeze for that judge.** When prove finds the
  findings were the judge's own mistake (the system behaved well and the judge
  scored it wrong), it writes those moments to the run's files as
  `judge-defects.json`, a list of `{judge, finding, sentence, name}`. The
  dissolve station closes the cause saying the judge was wrong and prints
  `{"dissolved": "judge_defect", "moments": n}` (else
  `{"dissolved": "no_repro"}`); the runner keeps a station script's output
  head on its node (`result_preview`), so that line is the run's
  machine-readable record. For Union, `collect.py line` in the judge evals
  directory (`~/.local/share/codecast/flowfactory/judge-evals`, hand-run) reads
  every `judge-defects.json` under the repo's `cast-line` run directories,
  fetches the logged judge call behind each finding (read-only), and adds each
  as a miss moment to `moments.json`, once. The prove prompt does not ask for
  `judge-defects.json` yet; that instruction is a prompt change and ships with
  its own before and after evals (prompting.md P9).
- **A judge needs the facts it is judging.** It cannot compare behavior with
  an expectation without the state of things at the moment it judges: what
  was delivered and what is still in flight, and the time. A finding that
  only looked wrong because a reply had not landed yet is the judge's input
  failing, not the system misbehaving.

Three numbers say how quality is going, and none of them is the count of
findings. `packages/web/lib/line/lineMetrics.ts` computes all three from the
store's signals, causes and runs over a window (`lineMetrics`):

1. **Expectation breaks per day** (`expectationBreaks`): signals created in
   the window whose subject is an expectation id, leaving out those whose
   cause's latest line run dissolved as a judge mistake, divided by the
   window's days. This is the outcome. It counts only expectation-grounded
   finders (LM5); a metric-grounded finder's signal is not a break.
2. **Explained share** (`explainedShare`): of the signals created in the
   window, the share the attach step put on a cause it already had (attach
   `fingerprint` or `judge`) rather than a new one (`new`). A signal a person
   placed counts on neither side. High means the cause list explains what the
   finders see; low means quality is moving faster than the line understands
   it.
3. **Fixes that hold** (`fixesThatHold`): of the watches that ended in the
   window, the share that ended quiet (`quietWatchEnd`, the rule the map reads
   "held" by) rather than with a signal that reopened the cause. Low means the
   line ships changes that do not fix the cause.

A window with nothing to count reports no share rather than zero. The board
is healthy when the first falls, the second is high and the third holds; the
number of open findings or clusters is not a goal.

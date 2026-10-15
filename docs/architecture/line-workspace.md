# The line app: one process, many projects

The line is one process that turns findings into fixed, watched problems. A
person reads it, checks it against real cases and changes it in one app over
one model, with one set of widgets and one set of actions. Sections are LW1
onward.

## LW1. One app over the process

`/line` is the app. A project is a filter on it, never a line of its own:
every project's problems run through the same processes (the graphs that
exist: codecast's line, and a product's own such as Union's AgentWatch).
`/line/<project>` opens `/line?project=<project>`, and a project's Line tab
draws the same app pinned to that project.

The header holds the process picker (each graph with how many runs it has),
the project filter (every project by default; a dropdown of the projects with
work on the line, each with what waits there), the auto-start state (one
project's switch, or over every project how many start work on their own, with
a switch per project) and how many things wait for you.

With no process in the address the app draws the one the person last picked
on this device, else the first in the picker's fixed order, never the busiest:
run counts move as runs load, and a default that follows them changes the
process under the reader. A link that names only a run, a problem, a trial
card or a decision opens on that thing's own process.

The left nav opens six views, on keys 1 to 6:

- **Inbox**: what waits on you, as rows grouped by what to do: cards to
  decide, fixes that shipped past an unanswered card, problems holding for
  your answer or review, runs that failed or went silent, projects whose line
  cannot start. Each row names the thing (the problem, the question, why the
  run failed) and carries one action (`lib/line/lineInbox.ts`). A trial run paused where no answer can land
  (its step left the line, or no session asked its card) carries one act,
  Re-ask, which rides the store's `trialReask` to the run's own machine (the
  daemon's `line_trial_reask`, the same re-ask `cast line trial rerun --reask`
  does). Failed runs are the pipeline's health: one folded line, listed and
  never counted for the viewer, and one opened leads with what stopped it and
  what Retry does.
- **Sources**: where problems come from. Each source with what it filed, and
  its findings; a finding opens its problem.
- **Problems**, the home (`/line` opens here): a strip of the fixes waiting
  for you (into the Inbox), then one chart of every problem's findings over
  24h, 7d or 30d, stacked by problem (the busiest six colored, the rest gray),
  what came back after a close hatched red, and closes and shipped fixes
  marked under it; brushing a span or clicking a problem's band narrows the
  list. Each row has a sparkline on the chart's axis, findings and
  conversations in the window, status, came back, last seen, and where its
  fix stands (for you, being built, shipped, answered, none yet). An open
  problem leads with the fix waiting on you (its decision, LineDecision; a
  trial card no station posted as a decision, TrialCardPanel), then its
  timeline (`lib/line/problemsOverview.ts`).
- **A problem** opens its timeline, the way
  an error tracker shows an issue: occurrences (the signals, bucketed) as a
  histogram, and on the same axis every fix attempt (a run, from start to end,
  colored by how it ended), every ship and merge, every deploy that carried the
  fix, and the watch window after it. Every close is marked on the axis: a fix
  going live, or an attempt that closed the problem without a change
  (dissolved, dropped). Occurrences after a fix went live (its deploy, else its
  merge, else its ship) are a regression; occurrences after a close without a
  change are the problem coming back ("Came back"). A problem whose newest
  close did not hold is listed first.
- **Runs**: every run of the process, newest first. One opens its detail, the
  Replay: the run played step by step like a debugger, with a scrubber; at any
  step, what it received, what it decided, why; mark it wrong there, edit the
  prompt, try again.
- **Process**: the process itself, in two modes. Graph draws the steps (agents,
  scripts and people unmistakably different, branches labeled in words, edge
  weight by how often runs took them, a run's path lit with step numbers;
  Essence and All steps). Notebook reads it as one calm document, a step at a
  time: its job, where it sends work, its runs, its prompt, improve it.
- **Chat**: a conversation with the line. Replies carry live widgets, not
  walls of text.

The URL carries the selection: `project`, `view`, `mode` (graph, notebook),
`graph`, `step`, `tab`, `run`, `case`, `source`, `finding`, `card` and
`decision` (`lib/line/lineWorkspaceUrl.ts`). A decision (sd-N) opens as
LineDecision where the reader is: beside the Inbox's list, leading its problem
in Problems, or over the run that waits on it in Runs. A trial card its station
posted as a decision is named by that decision's id on every surface. Every view opens the same step drawer and
shares the selection: the step, run or problem selected in one view is
selected in the others.

## LW2. One model

`lib/line/lineModel.ts` builds the model from store rows (every project's, or
the filtered project's), pure and tested: the
graph (nodes, edges with plain branch words, stages, diagnose/fix halves), each
step (kind agent, script, person or end; one-line purpose; prompt with the
shared sections it includes; outcomes with where each leads and how often),
each step's decisions (what it received, what it decided, its reasoning,
labels), runs as paths of visits, the issues (causes) runs worked, and each
cause's history: its occurrences over time, its attempts, ships, merges and the
deploys that carried them, its watch windows and its regressions. It
builds on `lineGraphs`, `runReport` and `lineTrace`; nothing is computed twice.

## LW3. Widgets, everywhere

`components/line/widgets/` holds the pieces every view and the chat use: the
graph, a step card, a prompt (rendered, includes folded, editable), a prompt
diff, a step's runs, a before/after table, a run path. A step's runs
(`StepRuns`, the drawer's Runs tab) are one block per problem: its ref, title
and source (the source and judge most of its findings name, "AgentWatch ·
comms"), then a row per run with its outcome, what the step put out in its own
words (a script's printed line, an agent's finding, a person's note), where the
run went next, how long it took and when. Earlier runs on the same problem fold
under a count. Opening a row shows what the step was given, its full words, the
fields it reported, and links to the run, the problem and the session. Right
and wrong are two icon toggles that show on hover unless set. A fenced
block (` ```line ` with a small JSON spec) renders any widget wherever
markdown renders, so an agent's reply in any conversation can show a step, a
diff or a before/after table, live and actionable.

## LW4. Real actions

- **Edit a prompt**: writes the prompt file the graph names, in the repo that
  holds the graph, through the machine that published it (the line edit path,
  generalized from a repo's `<repo>/.codecast/line/` to any published graph). Every save is a
  version of the step.
- **Try**: runs the edited step on chosen past cases in a sandbox that refuses
  writes, on the publishing machine: the case's recorded input with the edit
  applied, through `prompt-dry-run.ts` with its guard. Old and new answers side
  by side. Nothing ships from a try.
- **Label**: a decision marked right or wrong (with a note) is stored, and is
  the step's test set.
- **Ask an agent**: files a cause against the line (LX6) carrying the person's
  words and the labeled cases; the line edits the prompt, replays the step on
  the labeled set, and returns a card with before/after.
- **Chat**: a conversation with the line is a session of its own, held by a
  project: the filtered one, else the project that runs most of the drawn
  process (the same project Try and Ask an agent write to). It is started at the person's first message and nested under the project lead's
  standing session when there is one, briefed to answer from the model and to
  reply with widgets. The lead owns it; its own thread never interleaves a line
  answer with its other work.

## LW5. A cause remembers its attempts

A cause that comes back must not get the same fix twice. The history is read
only from codecast's own records (the cause task, its signals, its runs, their
cards, ships and deploys), never from a product's own attempt or cause tables,
which are duplicate records of the same work and are being retired. Every run on a cause
receives the cause's history as context: each earlier attempt (what it found,
what it proposed, what was built, the card and how it was answered), each fix
that shipped and when its deploy landed, every close without a change and whether
the problem came back after it ("Dissolved 3x as no fix needed; it came back
each time"), and what happened after (the watch ended quiet, or occurrences
came back, with examples). The stations that
diagnose and propose (codecast's analyze, plan and implement; AgentWatch's
investigate, propose and build) start from that history: when an earlier fix
shipped and the problem came back, the new attempt explains why that fix did
not hold before proposing anything, and does not propose it again. A cause
that regresses reopens with this history attached, so the person's card for
the new attempt shows the earlier fix beside the new one.

# The line workspace: five views of one line

A project's line is something a person reads, checks against real cases and
changes. The workspace shows it five ways over one model, with one set of
widgets and one set of actions. Sections are LW1 onward.

## LW1. One workspace, five views

Route `/line/<project>` (and the project's Line tab) opens the workspace for
the project's line. A project whose causes run more than one graph (Union's
Agent Quality runs the AgentWatch graph and codecast's line) picks the graph
in the header. The URL carries `view`, `graph`, `step`, `run` and `case`, so
any state is a link. `/line` stays the overview of every project.

- **Graph**: the steps as a graph, agents, scripts and people unmistakably
  different, branches labeled in words, edge weight by how often runs took
  them, a run's path lit with step numbers. Essence (scripts as dots, script
  loops hidden) and All steps. Keyboard first.
- **Notebook**: the line as one calm document, a step at a time: its job, where
  it sends work, its decisions, its prompt, improve it.
- **Replay**: a real case played through the line like a debugger, step by step
  with a scrubber; at any step, what it received, what it decided, why; mark it
  wrong there, edit the prompt, try again.
- **Chat**: a conversation with the line. Replies carry live widgets, not
  walls of text.
- **Timeline**: the life of each problem over time, the way an error tracker
  shows an issue. Occurrences (the signals, bucketed) as a histogram, and on
  the same axis every fix attempt (a run, from start to end, colored by how it
  ended), every ship and merge, every deploy that carried the fix, and the
  watch window after it. Every close is marked on the axis the way an error
  tracker marks "resolved in": a fix going live, or an attempt that closed the
  problem without a change (dissolved, dropped). Occurrences after a fix went
  live (the deploy that carried it, else its merge, else its ship) are a
  regression; occurrences after a close without a change are the problem
  coming back after that attempt ("Came back"). Both are marked, and a problem
  whose newest close did not hold is listed first. The line-level timeline lists the
  project's problems with a sparkline each, newest activity first, regressed
  first; opening one shows its full timeline with each attempt's card and diff.

All five open the same step drawer and share selection: the step, run or case
selected in one view is selected in the others.

## LW2. One model

`lib/line/lineModel.ts` builds the model from store rows, pure and tested: the
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
diff, a decision card and list, a before/after table, a run path. A fenced
block (` ```line ` with a small JSON spec) renders any widget wherever
markdown renders, so an agent's reply in any conversation can show a step, a
diff or a before/after table, live and actionable.

## LW4. Real actions

- **Edit a prompt**: writes the prompt file the graph names, in the repo that
  holds the graph, through the machine that published it (the line edit path,
  generalized from `.codecast/line/` to any published graph). Every save is a
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
- **Chat**: a conversation with the project's line is a session of its own,
  started at the person's first message and nested under the project lead's
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

# The line workspace: four views of one line

A project's line is something a person reads, checks against real cases and
changes. The workspace shows it four ways over one model, with one set of
widgets and one set of actions. Sections are LW1 onward.

## LW1. One workspace, four views

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

All four open the same step drawer and share selection: the step, run or case
selected in one view is selected in the others.

## LW2. One model

`lib/line/lineModel.ts` builds the model from store rows, pure and tested: the
graph (nodes, edges with plain branch words, stages, diagnose/fix halves), each
step (kind agent, script, person or end; one-line purpose; prompt with the
shared sections it includes; outcomes with where each leads and how often),
each step's decisions (what it received, what it decided, its reasoning,
labels), runs as paths of visits, and the issues (causes) runs worked. It
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
- **Chat**: a conversation with the project's line is a session that owns the
  line (its lead role's, else a line session), briefed to answer from the
  model and to reply with widgets.

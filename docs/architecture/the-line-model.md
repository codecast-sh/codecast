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
  cites the expectation it breaks.

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
the quote against that record). Any other change waits for the project's
person, as a card in their queue whose Apply lands it. `cast expectations show|propose|apply|drop`
is the CLI; `/cli/expectations/brief` is what a judge reads (the active lines
with ids under the version to cite). The line template's
`expectations-daily` routine is the proposer; its cursor is the newest window
a proposal recorded, and a proposal an operator retracts (one that should never
have run) records none. Shapes and the parser: `shared/contracts/expectations.ts`.

## LM6. Changing the line

The line's definition is its profile, its graph and its station prompts. It
lives in the project's repo, versioned with the code, and is mirrored to the
app so anyone can read it on the project's Line tab. Editing it in the app
writes the change to the repo. Every run records which version it ran, so the
Line tab shows what each version delivered: runs, shipped, revised, dropped,
reopened, cost. A change to a station prompt is a prompt change like any
other, and goes through the line with evals before and after.

## LM7. Where people see it

The line shows up wherever its objects already appear, never only on a page of
its own:

- the task page tells a cause's story (signals, goal, expectation broken,
  where it is, the card, every run);
- task lists and boards show the status and the watch;
- the decision queue holds the cards;
- notifications reach the right person when a card waits, a change ships, or
  a watched cause reopens;
- the run page reports one run;
- the project page's Line tab shows the project's flow, sources, expectations,
  stations and versions;
- `/line` rolls every line up across the team.

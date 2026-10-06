# The line map: see the whole line, trace one thing, change it in place

`the-line-model.md` says what the line's objects are and where they live.
This document specifies the one surface where a person sees a project's line
as a system, follows a single thing through it, and changes it. Sections are
numbered LX1 onward so code can cite them.

## LX1. One surface

A project's line is one page: the map. It is the project's Line tab
(`/projects/<id>?tab=line`), and `/line` is the same map for the project in
focus with a switcher and an all-projects roll-up that only counts. Settings
are not a separate place: every value of the line is read and changed where it
shows on the map (LX5), so `/line/settings` opens the map with the matching
panel open. The task page's cause story, the run page and the decision card
link into the map's trace (LX4) instead of each telling part of the story.

## LX2. The map

The map draws the project's line left to right as the path work takes, from
the world to a held fix, and lays the data over it.

- **Nodes, from the definition.** Sources (one per declared finder, plus
  people and lessons), Expectations (feeding the finders that judge behavior),
  Signals (intake and attach), Causes (the admission queue), each station of
  the project's actual graph in order (the shipped line or the project's own,
  so a customized line draws as customized), Decide, Ship, Watch, and the ends:
  Held, Reopened, Dissolved, Dropped. Branches the graph takes (dissolve, the
  revise loop back to implement, drop) draw as branches.
- **Data, over a window.** 24 hours, 7 days or 30 days. Each node shows how
  many items are there now and how many passed through in the window. Each
  edge's width is the number of items that crossed it in the window. A node
  with stuck items (past its usual time), failures or a silent finder is
  marked, and the mark says what is wrong in words.
- **Derived locally.** The map is a pure function of rows the store already
  holds (signals, cause tasks, workflow runs, decisions, the project's
  published profile and graph): `buildLineMap` in `packages/web/lib/line/`,
  tested on fixture rows. It never waits on a query to paint.

## LX3. Node panel

Clicking a node or an edge opens its panel beside the map. One shape for all:

- **Now**: the items at this node, oldest first, each with its age and a link
  to its trace.
- **Through**: the items that passed in the window, with how each left
  (moved on, failed, dissolved, dropped) and how long it stayed.
- **Health**: in words first, numbers second: failure share, median time,
  cost per item, a finder's last signal.
- **Definition**: what this node is and every value that shapes it (a
  finder's declaration, a station's prompt, script and timeout, a command, a
  cap, the watch length, the expectations), each editable in place (LX5), with
  the version history of this node.
- **Change**: a composer to ask an agent for a change to this node (LX6).

An edge's panel is the items that crossed it.

## LX4. Trace

A trace follows one thing through the line. `/line/trace/<ref>` takes any
ref the line knows: a signal, a fingerprint, a cause task, a run or a card
decision. The same trace opens in the panel from any item on the map.

- **On the map**, the trace dims everything else and draws the item's path,
  including loops it took (two implement rounds draw twice).
- **As a story**, a vertical timeline with one step per stage, each saying
  what happened, when, how long it took and what it produced:
  finding (what the finder saw, in its words, the expectation it breaks, and
  a link back to where it was seen, such as the AgentWatch cluster) → group
  (other signals with the same fingerprint, and how this one attached) →
  cause (title, goal, category, readiness) → each run, station by station
  (outcome, duration, the station's session, its artifacts: proof, eval
  result, review) → card (headline, recommendation, who answered what, when)
  → ship (what landed where) → watch (its window and any signal in it) →
  outcome (held, reopened, dissolved or dropped, and why).
- A step with nothing yet says what it is waiting on.

## LX5. Editing in place, with the repo as home

The line's definition is its profile, its graph and its station prompts, and
all three live in the project's repo (LM6):

- the profile in `.codecast/line.toml` (LP2);
- the graph and the station prompts in `.codecast/line/`: `line.cast` and one
  file per station prompt, written out from the shipped line the first time a
  project changes a station. A run in that project uses the repo's line when
  it exists, else the role's line, else the shipped one.

An edit made on the map travels the profile's edit path: a command to the
machine that published the project's line, which writes the file in the repo,
checks it, and republishes, so the app mirrors what the repo holds and every
run records the version (`graph_hash`) it ran. A value edit is direct. A
change to a station's prompt is a prompt change: the editor offers to send it
through the line (LX6) rather than apply it untested.

## LX6. Changing the line with an agent

The composer on the map and on every panel files a cause against the line
itself: a task in the project with category `line`, its subject the node it
names (`line:station:prove`, `line:finder:agentwatch`), the person's words as
its first signal. The line runs it like any change. Implement edits the
line's files on a branch; prove shows the problem on recorded runs where it
can; eval replays the changed station on recorded inputs when the profile has
an eval command for stations, and otherwise the card says the change is
unscored; the card shows the diff; Ship lands it in the repo and the line
republishes. The line changes itself under the same rules as everything else.

## LX7. Sources back to their origin

Every signal carries where it was seen (`evidence_url`), and the trace's first
step links there. A finder sets that link to the most specific page it has:
AgentWatch to the finding's cluster on its admin page, CI to the failing run,
chat to the line someone typed.

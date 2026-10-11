# The line map: see the whole line, trace one thing, change it in place

`the-line-model.md` says what the line's objects are and where they live.
This document specifies the one surface where a person sees a project's line
as a system, follows a single thing through it, and changes it. Sections are
numbered LX1 onward so code can cite them.

## LX1. One surface

A project's line is one page: the map. It leads the project's Line tab
(`/projects/<id>?tab=line`), followed by the project's expectations and what
each version of the line delivered. `/line` is the same map for the project in
focus, with a switcher of project chips (each showing its waiting cards) and an
all-projects roll-up that only counts. The map's state lives in its URL
(`?node=`, `?edge=`, `?window=`, `?trace=`, `?project=`), so every panel,
window and trace is a link.

Settings are not a separate place: every value of the line is read and changed
where it shows on the map (LX5). `/line/settings` redirects onto the map with
the matching panel open: a station's panel for `?station=`, else the line's
settings panel (`?node=line`) at the `?section=` it names.

The task page's cause story, the run page and the decision card each link into
the trace (LX4) instead of each telling part of the story.

## LX2. The map

The map draws the project's line left to right as the path work takes, from
the world to a held fix, and lays the data over it.

- **Nodes, from the definition.** Sources (one per declared finder, plus
  people and lessons, which are always sources, plus any source that filed
  without being declared, marked so), Expectations (feeding the finders that
  judge behavior), Signals (intake and attach), Causes (the admission queue),
  each station of the project's actual graph in order (the shipped line or the
  project's own, so a customized line draws as customized), Decide, Ship,
  Watch, and the ends: Held, Reopened, Dissolved, Dropped. Branches the graph
  takes (dissolve, the revise loop back to implement, drop) draw as branches
  in a lane under the main row. Past five sources, the quiet ones fold into a
  "+N more sources" pill; a source in trouble, the open one and one on a trace
  always stay.
- **Data, over a window.** 24 hours, 7 days or 30 days. Each node shows how
  many items are there now and how many went through in the window ("N
  through"; outcomes live in the mark, never in the count). An empty node says
  "empty", an end with none yet says "none yet". Each edge's width is the
  number of items that crossed it in the window.
- **How quality is going, first.** Under the map's controls one sentence
  says the line's three numbers over the same window, in words (the-line-model.md
  LM8; `lineMetricsWords.ts` over `lineMetrics.ts`): expectation breaks a
  day, the share of new signals that joined a cause the line already knows,
  and how many of the fixes whose watch ended held. A number with nothing to
  count says so ("no watches ended yet") rather than showing zero.
- **Marks say what is wrong in words.** A node with stuck items (past its
  usual time), failures, a silent finder, or a queue that does not move is
  marked, tinted, and its mark says why in a few words with the full sentence
  in its tooltip. Causes always names why nothing starts when work waits: no
  project, no role looks after it, the role is paused, admission is off, the
  day's cap is spent, every slot is busy, none of the causes is ready, or
  ready causes have waited with no start (the sweep is not running).
- **Opening view.** The map opens on where attention is due: the node holding
  a card for the viewer, else the node in the worst trouble, else the busiest
  (`openTarget`). A strip under the map lists every node holding work, each a
  button that opens its panel.
- **Derived locally.** The map is a pure function of rows the store already
  holds (signals, cause tasks, workflow runs, decisions, the project's
  published profile and graph): `buildLineMap` in `packages/web/lib/line/`,
  tested on fixture rows. It never waits on a query to paint.

## LX3. Node panel

Clicking a node or an edge opens its panel beside the map, and the map steps
back to keep the selected node and its neighbours in view. One shape for all:

- **Now**: the items at this node, oldest first, each with its age and a link
  to its trace. Items sharing a title prefix group under it; test signals fold
  under their own heading. A source never holds work, so its panel has no Now
  and opens on Through.
- **Through**: the items that passed in the window, with how each left
  (moved on, failed, dissolved, dropped) and how long it stayed.
- **Health**: in words first, numbers second: failure share, median time,
  cost per item, a finder's last signal. On Causes, the first line is why
  nothing starts (LX2), followed by the role's admission switch and its slots,
  edited in place on the role (admission belongs to the role whose area holds
  the project, not to the profile), and "Start the top cause" when the queue
  is stalled. The switch is the line's own start switch (learning-loop.md LL5:
  `caps.line_on` beside `caps.cards`, off until a person turns it on, and only
  on while the role's own switch is); it says how many problems turning it on
  would start. The project's Line tab shows the same control above its map.
- **Definition**: what this node is and every value that shapes it (a
  finder's declaration, a station's prompt, script and timeout, a command, a
  cap, the watch length, the expectations), each editable in place (LX5). A
  source that files without a declaration offers one action to declare it. A
  station lists its own version history: each version of the line in which
  that station changed, from when, and what it delivered (runs, shipped,
  stopped).
- **Change**: "Ask for a change to <node>", pinned to the panel's foot, opens
  the composer for this node (LX6). With no panel open, the controls row asks
  about the whole line.

An edge's panel is the items that crossed it.

## LX4. Trace

A trace follows one thing through the line. `/line/trace/<ref>` takes any
ref the line knows: a signal, a fingerprint, a cause task, a run or a card
decision, and reads the cause from the workspace it lives in. The same trace
draws on the map from any item (`?trace=`).

- **On the map**, the trace dims everything else and draws the item's path,
  including loops it took (two implement rounds draw twice, marked x2).
- **At the top**, one sentence says where the item is now, built from one
  value: the station the newest run is at, a card waiting on someone (with the
  button to answer it), or an approved ship nobody is driving (with the run to
  open). A strip of the stations on its path follows, each chip colored by
  its last visit (passed, stopped, replaced, current, pending).
- **As a story**, a vertical timeline with one step per stage, each saying
  what happened, when, how long it took and what it produced:
  finding (what the finder saw, in its words, the expectation it breaks, and
  a link back to where it was seen, such as the AgentWatch cluster) → group
  (other signals with the same fingerprint, how this one attached, and any
  other cause the same finding opened elsewhere) → cause (title, goal,
  category, readiness) → each run, station by station (outcome, duration, the
  station's session, its artifacts: proof, eval result, review; runs that end
  the same way fold together, and a run whose card was withdrawn because a
  newer run started reads as replaced, not stopped) → card (headline,
  recommendation, who answered what, when) → ship (what landed where) → watch
  (its window and any signal in it) → outcome (held, reopened, dissolved or
  dropped, and why).
- A step with nothing yet says what it is waiting on.

## LX5. Editing in place, with the repo as home

The line's definition is its profile, its graph and its station prompts, and
all three live in the project's repo (LM6):

- the profile in `.codecast/line.toml` (LP2);
- the graph and the station prompts in `.codecast/line/*`: `line.cast` and one
  file per station prompt or script, written out from the shipped line the
  first time a project changes a station. A reset that leaves every station as
  shipped removes the copy again, so the project follows the shipped line and
  its later updates. A task-bound run in that project uses the repo's line when
  it exists, else the role's line, else the shipped one.

An edit made on the map travels the profile's edit path
(`dispatch.editLineProfile` to the daemon's `line_profile_edit`): a command to
the machine that published the project's line, which writes the file in the
repo through the config fence, checks it with the parser before writing
anything, and republishes, so the app mirrors what the repo holds and every
run records the version (`graph_hash`) it ran. The map paints the edit at once
and shows where it is (with the machine, republishing, done, refused). A value
edit is direct. A change to a station's prompt is a prompt change: the editor
offers to send it through the line (LX6) beside applying it now.

## LX6. Changing the line with an agent

The composer files a cause against the line itself: a task in the project
with category `line`, its subject the node it names (`line:station:prove`,
`line:finder:agentwatch`, `line:profile:watch_days`, or `line:whole`), the
person's words as its first signal, and any draft they wrote attached for the
agent to weigh. The composer lists the causes already filed on that node. The
line runs it like any change, with its own prove and build stations:

- **Ground** sets category `line` and goal `line`, the line's own health (its
  three numbers, the-line-model.md LM8, and every station doing its job),
  which every goals brief offers beside the product's goals
  (the-line-end-to-end.md LE5). A change to the line never serves a product
  goal, and never parks as serving none.
- **Prove line** (`line/prove_line.md`) names the recorded runs where the
  named part did what the cause describes, in `$run_dir/line-proof.json`:
  per run its task, id, station, and the station's status, outcome or the
  run's fail reason as the records hold them. When the line's files can be
  checked directly (a graph's routing, a profile value, a script), it also
  leaves a failing test as `repro.sh`.
- **Red** checks every claim against the run records (`cast line
  proof-check`, `cli/src/lineProof.ts`) and fails a proof that names a run the
  line never recorded, or a status, outcome or reason the record does not
  hold; a `repro.sh` must also fail on the base. A comment is never proof.
- **Implement line** (`line/implement_line.md`) edits the line's own files;
  every way back to the builder (checks failed, still red, eval failed,
  review changes, Revise, a rebase conflict) returns a line cause there.
- **Green** turns the checked runs and the test into the card's proof, red
  before and green after; a station prompt change with no test has no proof
  to rerun, and eval scores it on that station's eval surface (`ground` and
  `card-write` have one), else the card says it is unscored.

The card shows the diff, Ship lands it in the repo, and the line republishes.
The line changes itself under the same rules as everything else.

## LX7. Sources back to their origin

Every signal carries where it was seen (`evidence_url`), and the trace's first
step links there and shows the finder's own words. A finder sets that link to
the most specific page it has: AgentWatch to the finding inside its cluster on
Union's admin page, CI to the failing run, chat to the line someone typed.

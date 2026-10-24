# Flows: a shared pool of structured ways to run a change

Sources and flows belong to the team; a project is a home for problems
(the-line-model.md LM1). The line (`the-line.md`, `the-line-end-to-end.md`) turns findings into fixed,
watched problems. Most changes do not start as a finding: a person or an agent
in an ordinary session writes them. This document makes both kinds run through
the same structured flows, drawn from one pool, so every change goes through a
process people and agents can see. Sections are FL0 onward so code can cite
them.

## FL0. A flow, and who owns it

A flow is four things: its steps (the graph a run walks), what it takes in
(the finders and projects that feed it), an on switch, and who decides at the
end. A flow that starts work by itself has an owner: the role that leads its
projects. The owner answers the flow's asks first and recommends on its cards,
through the role ladder every decision climbs (`sessionDecisions.routeFor`).

An owned flow is derived from its owner role, never stored on its own
(`web/lib/line/ownedFlows.ts`):

| Part | Where it lives |
|---|---|
| Steps | `org_roles.line_workflow_slug`, the shipped template when unset (read as "Standard"); a version per finding source by `workflows.serves` |
| Takes from | the projects the role leads (`projects.owner_role_id`, `lineRoleOf`) and the finders that file into them (`projects.line_profile.finders`) |
| On switch | `org_roles.caps.line_on`, with the role's `trust` (`lineStartsOn`) |
| Decides | the person the role's reporting line ends at; the workspace owner for protected categories (line-profile.md LP6) |
| Merge, review agent | `org_roles.line_merge`, `org_roles.review_backend` |

One role owns at most one flow. Many flows may run the same steps: every flow
on the shipped template shares it, and customizing steps copies the graph into
the project's repo. A flow is named by its owner (`/flows/<handle>`, titled
with the role's name). Flows in the pool with no owner (`change` and the
segments) are run by hand: steps only, decided by the person who answers for
the change.

## FL1. Words

| Word | Meaning | Home |
|---|---|---|
| flow | one graph in the pool: a `.cast` file the runner executes | `.codecast/flows/<slug>.cast`, a shipped template, or a `workflows` row |
| owned flow | a flow a role owns, which starts its projects' problems by itself while on (FL0) | the owner role's fields |
| whole flow | a flow that takes a change all the way to done | a flow whose graph says `kind="line"`, or the shipped `line` |
| segment | a flow that does one part of the path, such as check, eval, review, decide or ship, or prove then implement | a flow whose graph says `kind="segment"` |
| pool | every graph a team can run: shipped, the repo's, and the team's pushed ones | `cast flow ls`, the flow list on /flows |
| change | what runs through a flow: a task's branch, a session's own edits, a branch, a pull request | the run's bound task, `$branch`, `$worktree` |

Every flow is run, versioned, gated and drawn the same way (the-line.md).
Nothing here adds an engine, a decision rail or an evidence model. Identifiers
keep their names: the shipped slug `line`, `kind="line"`, `.codecast/line.toml`,
the `org_roles.line_*` fields and the `cast line` commands.

## FL2. The pool

A flow lives where its project's code lives, as the line does (LM6):
`.codecast/flows/<slug>.cast`, with its station prompts and scripts beside it
in `.codecast/flows/<slug>/`. A flow is versioned with the code, reviewed like
code and published to the app on push, so anyone on the team can read it.

Resolution of a flow name, in order: a path on disk; the repo's
`.codecast/flows/<slug>.cast`; a flow the CLI ships
(`packages/cli/src/workflow/templates/`); a flow published to the workspace's
pool, by slug.

The pool is the team's. `cast flow publish` files the flow's `workflows` row
under the publisher's team workspace (`workspace` is `team:<id>`, `team_id`
routes it; `--team` names another team, `--team personal` keeps it theirs),
and every member reads it: the web through `workflows.webPool` into the
`workflows` collection, the CLI through `/cli/workflows/pool`, marked as the
team's with who published it. Any other push (a run's, the web's edit) is its
owner's alone and leaves a published row where it is; a push that makes the
graph a draft or drops `kind=` takes it back to its owner. A row from before
keys stays its owner's (`workflows.backfillWorkspace`). To run a teammate's
flow, the CLI writes the row's source and each station's text under
`~/.codecast/flows/<row id>/` at the paths the publisher's checkout held them,
and runs that file.

The graph says what kind of flow it is and what it is for, so the pool needs no
second record of it:

```dot
digraph review {
  graph [kind="segment", label="Review", description="An independent session reads the diff against the intent", takes="branch"]
  ...
}
```

- `kind`: `line` or `segment`. Declaring a kind is what puts a graph in the
  pool: any other graph (a probe, a trial's copy, an old template) can still
  be run by name, and is offered to nobody. The shipped `line` is in the pool
  without one, and so is every `.codecast/flows/<slug>.cast` in the repo.
- `label`, `description`: the name and the one line a picker shows.
- `takes`: what the flow needs from the change. `task` (a task with a goal and
  criteria), `branch` (a branch or worktree holding the change), or both.
- `draft`: the session an import belongs to until it is made general (FL5).

The CLI ships a starter pool: the `line`, the `change` line (check, review,
decide, ship), and the segments `check`, `eval`, `review`, `decide`, `ship`,
and `prove-implement`, cut from the shipped line's own station files so their
prompts stay one copy. The web reads the shipped pool from a generated
snapshot (`packages/web/lib/line/shippedFlows.generated.ts`, regenerated by
`bun packages/cli/scripts/gen-shipped-flows.ts`, checked by
`shippedFlows.test.ts`), and both sides fold a graph into its stations through
one function, `foldFlow` in `packages/shared/contracts/flowPool.ts`, so `cast
flow ls` and the app list the same steps in the same order.

## FL3. Segments compose

A node with `flow="<slug>"` (drawn `shape=folder`) runs a segment in place.
The parser expands it before anything else reads the graph: the segment's
stations join the graph under the node's id (`review__review`), its start
becomes the node's entry, and each of its exits becomes the node's way out.
The node's outgoing edges route on how the segment ended: `outcome = success`
when it reached a plain exit, `outcome = failure` when it reached a stop exit,
and `<node>.exit = <exit id>` names which exit it took.

Expansion is a parse step, so the runner, checkpoints, gates, graph hashes and
the map work unchanged: each expanded station is an ordinary station with its
own hash, and a change to the segment changes the hash of every flow that uses
it. The map groups an expanded segment's stations under the segment's name.

## FL4. How a change enters a flow

`cast flow run <flow>` binds a run to one change:

| Flag | The change | Bound task |
|---|---|---|
| `--task ct-N` | the task's branch (`line-<task>`) | that task |
| `--session [id]` (the default from inside a session) | the session's own edits | the session's active task, else a new task titled for the session and linked to it |
| `--branch <name>` | that branch | a new task titled for the branch |
| `--pr <n>` | the pull request's head branch | the task linked to the pull request, else a new one |

A session's own edits in a shared checkout are frozen the way `cast ship
checkout` freezes them (ship-checkout.md, `freezeAndAttribute`): every changed
file the session wrote since that file's last commit becomes one commit on
`codecast/<flow>-<task>`, and nothing in the shared tree, its index or HEAD
moves. Attribution is per file, so a file another session also wrote carries
that session's lines too; the run includes it and names the other session
rather than leave out part of the change. Credential files stay out. The
worktree is the one the run's isolated stations would make (`cast ws acquire`,
same name), and `$run_dir/change.json` records the change; the runner reads it
before the first station (`frozenChangeContext`), so `$branch` and `$worktree`
are set from the start, for a detached daemon run too. A rerun on the same
task moves the branch and resets that worktree to it, and refuses when the
worktree holds uncommitted work of its own.

Every run binds to a task because the run's evidence, its gate decisions and
its status already key on one (the-line.md L3, L6). The task is the record of
the change; the session that made it stays linked to it.

## FL5. A Claude Code workflow becomes a flow

A session that ran a dynamic workflow (the Workflow tool's `agent`,
`parallel`, `pipeline` and `phase` script) can add its shape to the pool:

```
cast flow import <script.js | wf_id> --as segment|line [--slug <name>]
```

1. **Trace.** The script runs in a sandbox with recording stand-ins for
   `agent`, `parallel`, `pipeline`, `phase` and the rest: no model, no
   network, no file access. Each stand-in records the call (its label, phase,
   prompt, schema, and which calls ran side by side) and returns a placeholder
   shaped like its schema, so loops and branches play out.
2. **Shape.** Code turns the trace into a graph: one station per agent call,
   calls made side by side become a fan-out and fan-in, a label that repeats
   across rounds becomes a loop back with `max_visits`, and the script's
   phases become the stages the map draws.
3. **Prompts.** Each station's prompt is written to its own file under
   `.codecast/flows/<slug>/`. A workflow's prompts usually carry the task they
   were written for; the session that wrote the workflow knows which words
   were the task, and rewrites them into `$task_title`, `$task_description`,
   `$branch` and the like. The command prints each prompt file for it.
   A script that reads `args` gets the args its run was launched with, read
   from the Workflow call in its session's transcript (`--args` overrides). A
   label carrying a round number ("critique:r2") marks a loop even when the
   placeholder answers ended the script after one round; the loop routes on
   the last step's `again` field, three rounds at most.
4. **A draft until it is general.** The import is written with
   `draft="<session>"`: only that session is offered it, and `cast flow
   publish` refuses it. The session makes it general (each station and the
   flow named for what it does in any change, a description and prompts that
   name no one task) and deletes `draft=`.
5. **Check and publish.** `cast flow validate` reads the graph and names what
   is missing; `cast flow publish` pushes it to the team's pool.

The Workflow card in the transcript offers "add to flows" once the run has
finished, which asks the session that ran it to do the import and make it
general, since it holds the context to.

## FL6. What people see

One drawing serves every surface (`FlowDiagram` over `lib/line/flowDiagram.ts`):
the path a change takes when every step passes, left to right; a segment of
several steps as a frame holding them; a fan-out as a frame of steps stacked
side by side; each step marked with who does it (an agent, a command, a
person). A definition shows the routes off the path as neutral words under the
step they leave, one form each: an end by its own name, a route to a station as
"outcome → station". A run shows each step done, current or stopped, and only
the route it took, red only where it stopped.

- **In a conversation**, a flow is one object (FL8): a `cast flow run` card
  follows the run live (state in words, the task, Stop while it runs, the
  library it builds on, Save) and stays visible, never folded into a "ran N
  commands" receipt; so does a flow the session wrote and read back
  (`validate -`, `show -`, a dry run). A ` ```flow ` fence draws
  `{"flow":"<slug>"}` or `{"run":"<id>"}` in any reply. The Workflow tool card
  carries "add to flows".
- **On a session's header**, Run through lists the pool's flows that take a
  branch, lines first, draws the picked one, and opens the shared confirm
  review: steps, agent sessions that start, questions for you, who does each
  step, the ways it can end, how to stop. Confirming asks the session to run
  its own change through it. The pool's feed is read only while the list is
  open.
- **On /flows**, the landing view (G then W) lists the owned flows, one row
  each: owner, on switch, the projects it takes from, who decides, its steps,
  and what it holds now. The decisions count opens Decisions narrowed to that
  flow (`?view=foryou&flow=<handle>`), the queued count its problems. Under
  them, the pool run by hand and the segments, each opening its detail: drawn,
  what it takes, what it is made of, what it is part of, and the changes that
  ran through it, each opening its live run card.
- **On /flows/<handle>**, one flow's page: its overview (counts, owner,
  switch, projects, decider, merge, steps drawn) and the same Decisions,
  Timeline, Problems, Steps and Deploys views over its projects, one picked at
  a time. `/line` addresses from before redirect to their place under /flows.

## FL7. What agents see

`cast flow ls` prints the pool, one flow a line: its slug, kind, what it takes,
and its passing path (`Check → Review → Decide → Ship`, side routes counted).
`cast flow show <slug>` prints each step, who does it, and where it sends the
work, a fan-out's branches under it. The Workflows section of the agent
instructions (`shared/contracts/snippetsWorkflow.ts`, also `cast guide
workflows`) carries the commands and the segment syntax. Session start adds
one `<flows>` line naming this checkout's pool (`flowsLine` in
`stableContext.ts`, about 320 bytes inside the 9000-byte budget the feed gives
way to).

## FL8. Flows a session writes, and backbones with slots

An agent puts its work in a flow one of three ways, and the agent instructions
(FL7, `cast flow --help`) say when each fits: a library flow that fits runs as
it stands; a library flow that fits as a backbone is extended, with the parts
this change needs done its own way written as generated segments; a flow is
written whole only when nothing in the library has the work's shape.

**Slots.** A backbone marks a node `slot="<what it must do>"`, optionally with
`flow=` for the steps it runs when nothing fills it (`change` leaves its Check
as a slot with the `check` segment as default). A flow that names the backbone
by `extends="<slug>"` fills the slot with `subgraph <slot> { ... }`. The parser
(`parser.ts`) reads a fill as an inline segment and expands it exactly as
`flow=` expands a library segment (FL3): its steps take the slot's id as
prefix, its first step is entered from the slot, and its last leaves by the
slot's own edges. A fill written as a chain gets its start and exit made for
it. A subgraph may fill only a slot of the base or a node of its own file, so
a backbone's other stations stay the team's; an empty slot makes a flow a
backbone that `cast flow run` and the runner refuse, naming the slots to fill.
`extends` resolves a file beside the graph first, then a flow by name through
the same resolver as `flow=` (a library run passes its own, pinned to the base
version it recorded).

**Flows written in a session.** `cast flow run -`, `validate -` and `show -`
read the graph from stdin (`workflow/sessionFlow.ts`). The file is kept at
`.codecast/session-flows/<slug>/<slug>.cast` inside the work tree (so a run's
push records where it lives, and the library collects it as a session flow),
hidden through the checkout's `info/exclude`, and marked `draft="<session>"` so
the library offers it to nobody until saved. Each library flow it names by slug
is pinned beside it by a one-line stub extending the file the pool read, so the
runner, a separate process, parses the graph that was validated. A name the
library holds is refused. `validate -`, `show -` and a dry run push it as the
session's own draft graph and print where it is kept, so the transcript can draw
it before it runs.

**The object in a transcript** (`hooks/useFlowObject.ts`, shared by web
`FlowFence` and the phone's `FlowCard`). A run draws the graph it ran (its
workflows row through `graphOfRun`, readable by anyone who can read the run),
the library's own copy when it is the same flow, else the team's session-flow
row. A segment written in place reads as a filled slot ("written here"), read
from the source (`flowFills`) or the session-flow row's `fills`; a pushed row's
segment exits are found structurally, since stored nodes carry no segment
fields. Save is the session-flow row for the run's graph (matched by
`graph_hash` and workspace) through the store's `saveSessionFlow`; a saved one
links to its library slug and version, and a graph the library already holds
as it stands has no row and shows no Save.

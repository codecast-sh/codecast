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
pool, by slug. The same order holds for a segment named inside another flow:
each published flow the CLI reads from the pool is written under
`~/.codecast/flows/<row id>/` and indexed by slug (`teamFlowIndex.ts`), so the
parser finds a team segment on this machine for a local run and a daemon run
alike. A read that names no team reads the pool of the team this directory is
mapped to (`cast teams map`), else the active team (`directoryTeam.ts`).

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
decide, ship), the `quick-change` line (check, review, ship: landed on the
reviewer's approval with no person asked), and the segments `check`, `eval`, `review`, `decide`, `ship`,
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
and `<node>.exit = <exit id>` names which exit it took. A stop exit the node
routes on keeps the segment's words for why: whatever the edge leads to reads
them as `$stop_reason` (cut to the lines that say what broke and the output's
end), and the segment's label as `$stop_stage`. A stop exit the node does not
route on ends the run, as before.

Expansion is a parse step, so the runner, checkpoints, gates, graph hashes and
the map work unchanged: each expanded station is an ordinary station with its
own hash, and a change to the segment changes the hash of every flow that uses
it. The map groups an expanded segment's stations under the segment's name.

## FL4. How a change enters a flow

`cast flow run <flow>` binds a run to one change:

| Flag | The change | Bound task |
|---|---|---|
| `--task ct-N` | the task's branch (`line-<task>`) | that task |
| `--session [id]` (the default from inside a session) | the session's own edits | the session's bound task while it is open, else a new task titled for the session and bound to it, so a second run finds the same task, branch and worktree |
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

### The session is the run's subject

A run on a session's edits talks to that session through its stages. The
session's conversation id is in `change.json` (`$change_conversation`), and it
is the run's spawner, since the session runs `cast flow run` itself (the Ship
button asks its agent to). A station with `backend=subject` is work for that
session: the runner sends its brief, which names what a stage found, as a
message in the session's own thread, waits for the session to work and settle
(the station wait every session node uses, `waitOnStation`, which holds
through a dormant pin and stops on a blocked one), then freezes the session's
change again on the same branch and resets the run's worktree to it
(`refreezeSessionChange`). The session is never reported as a hand of the run,
so the run's end never stops it.

The `change` flow (and `quick-change`, the same without Decide) routes every
stop it can fix to such a station; the briefs live in `templates/change/`: a failed
Check (with the check's output), Review's "changes" (the reviewer's findings;
the reviewer stays an independent session), Decide's Revise (the person's
note), and a rebase conflict at Ship. Each goes back to Check, and the stages
after run again on the new snapshot, so what Ship lands is exactly the commit
Review approved and Decide accepted, never the session's live edits (the ship
station passes `--branch $branch` to `cast ship run`). Each way back has
`max_visits=3`; the fourth visit ends the run. A rejection, a Drop and a ship
that fails for any other reason end it too. The session hears Decide's answer
when it is Ship, and how the run ended (done, or stopped where and why) in its
own turn. A run on a branch or a pull request has no subject, so its first
fixable stop ends it with what the stage found.

### Deploy: the run waits for the deploy that carries the change

Both change flows end at Deploy, after Land (the `ship` segment, labelled Land
there). The `deploy` segment is one station with `parks=true`: while the run
stands there it holds no machine slot and no session. The station runs `cast
flow await-deploy --branch $branch --base $default_branch` in the run's
worktree, which first waits for the change to land on the default branch (the
branch itself once main holds it, else a squash commit whose every file reads
as the branch left it), then reads the repository's deploy targets as `cast
line deploy targets --json` prints them (deploys.md DP10 to DP13) and keeps
the targets whose paths the change's files touch. A target is live once a
deploy recorded live has a sha the landed commit is an ancestor of, decided
with git in the worktree, so it needs no main-order data from the server; the
first such deploy is the dp-N that took it live. It has failed when the newest
deploy that holds the commit failed and none live holds it since. The wait
starts no deploy: a target's own policy does (a press, CI going green on main,
a push that deploys itself). When every touched target is live it prints
`Live: <sha> on <target> dp-N, ...` and the run ends there; the session's end
message carries that line. A failed deploy ends the run at "Deploy failed" with
the dp-N and its note. A change no target ships passes at once, and one that
never lands waits out the station's week. A flow that composes the segment may
name targets the change does not wait for, `deploy [flow="deploy",
except="aivery-operator"]`: one held back on purpose, whose live sha is not where
the change's watch should start. Union's fix flows end this way: Merge (or Ready
to land), then Deploy, then Watch, so a cause closes Done and starts its watch
only once production runs it, and a failed deploy leaves it In Review with a
blocker.

A segment declares the attributes it reads with `params="except"` in its graph
line; `$except` in its stations is the composing node's attribute, empty when the
node sets none. The value lands in a script as written, so the parser holds it to
words, names and paths.

While the session works, the run carries `waiting_on_session` (`node_id`,
`conversation_id`, `since`, `note`: what was sent, cut short), cleared when the
session settles or the run ends; each node status carries `visits`, against
the graph's `max_visits`.

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
- **The team's default flow** (`teams.default_flow`) is the flow a session's
  change is offered first. A team admin sets it with Make default on a flow's
  page in /flows, where the library marks it Default; any flow that takes a
  branch qualifies. A team that set none, or set one that left the pool, gets
  Change (`defaultFlowOf` in `lib/line/flowPool.ts`).
- **On a session's header**, Flows lists the pool's flows that take a
  branch, the team's default first and picked, then lines, each named with its
  description; it draws the picked one, and opens the shared confirm
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
one `<flows>` line naming the flows a session's own edits can run through:
this checkout's and its mapped team's (`flowsLine` in `stableContext.ts`,
about 320 bytes inside the 9000-byte budget the feed gives way to). Reading
the team pool there also refreshes this machine's copies of the team's flows.

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

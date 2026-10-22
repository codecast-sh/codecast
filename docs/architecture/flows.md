# Flows: a shared pool of structured ways to run a change

The line (`the-line.md`, `the-line-end-to-end.md`) turns findings into fixed,
watched problems. Most changes do not start as a finding: a person or an agent
in an ordinary session writes them. This document makes both kinds run through
the same structured flows, drawn from one pool, so every change goes through a
process people and agents can see. Sections are FL1 onward so code can cite
them.

## FL1. Words

| Word | Meaning | Home |
|---|---|---|
| flow | one graph in the pool: a `.cast` file the runner executes | `.codecast/flows/<slug>.cast`, a shipped template, or a `workflows` row |
| line | a flow that takes a change all the way to done; a project names one as its default | the project's profile (`[line] flow`), else the shipped `line` |
| segment | a flow that does one part of the path, such as check, eval, review, decide or ship, or prove then implement | a flow whose graph says `kind="segment"` |
| pool | every flow a team can run: shipped, the repo's, and the team's pushed ones | `cast flow ls`, the Flows view on /line |
| change | what runs through a flow: a task's branch, a session's own edits, a branch, a pull request | the run's bound task, `$branch`, `$worktree` |

"Line" keeps its meaning (the-line.md L1): a line is a flow, and every flow is
run, versioned, gated and drawn exactly as the line is. Nothing here adds an
engine, a decision rail or an evidence model.

## FL2. The pool

A flow lives where its project's code lives, as the line does (LM6):
`.codecast/flows/<slug>.cast`, with its station prompts and scripts beside it
in `.codecast/flows/<slug>/`. A flow is versioned with the code, reviewed like
code and published to the app on push, so anyone on the team can read it.

Resolution of a flow name, in order: a path on disk; the repo's
`.codecast/flows/<slug>.cast`; a pushed `workflows` row by slug; a flow the CLI
ships (`packages/cli/src/workflow/templates/`).

The graph says what kind of flow it is and what it is for, so the pool needs no
second record of it:

```dot
digraph review {
  graph [kind="segment", label="Review", description="An independent session reads the diff against the intent", takes="branch"]
  ...
}
```

- `kind`: `line` (the default) or `segment`.
- `description`: one line a picker shows.
- `takes`: what the flow needs from the change. `task` (a task with a goal and
  criteria), `branch` (a branch or worktree holding the change), or both.

The CLI ships a starter pool: the `line`, and the segments `check`, `eval`,
`review`, `decide`, `ship`, and `prove-implement`, each cut from the shipped
line's own stations so their prompts stay one copy.

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
checkout` freezes them (ship-checkout.md): the files attributed to that session
become one commit on `flow/<task>` in a worktree, and nothing in the shared
tree moves. The run starts with `$branch` and `$worktree` set, so a segment's
stations work on the change wherever it came from.

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
4. **Check and publish.** `cast flow validate` reads the graph and names what
   is missing; `cast flow publish` pushes it to the team's pool.

The Workflow card in the transcript offers "Add to flows", which asks the
session that ran it to do the import, since it holds the context to
generalize the prompts.

## FL6. What people see

- **In a conversation**, a `cast flow run` card draws the flow's graph with the
  run's live state on each station, and a ` ```line ` fence with
  `{"widget":"flow","flow":"<slug>"}` draws any flow in the pool. The Workflow
  tool card carries "Add to flows".
- **On a session**, "Run through" lists the pool's flows, each with its
  stations drawn small; picking one asks the session to run its change through
  it.
- **On /line**, the Flows view lists the pool: each flow drawn, its kind, where
  it lives, its runs and what they delivered, and the flows that use it as a
  segment. Opening one draws it in the Process view.
- **On mobile**, the flow run card and the Flows list render read-only.

## FL7. What agents see

`cast flow ls` prints the pool, one flow a line: its slug, kind, what it takes,
and its stations in order (`check → eval → review`). `cast flow show <slug>`
prints the graph as text with each station's job. `cast guide flows` explains
running a change through a flow. Session start guidance names the command in
one line, so an agent finishing a change knows the standard way to send it on.

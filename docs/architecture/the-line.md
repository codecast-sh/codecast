# The line: stations, gates, evidence, runs

One system for automated work with people in the loop. A scope owns a line.
A task moves along it through stations. A run is one passage. A gate on the
line is a decision in the person's queue. Evidence attaches to the task at the
station that produced it. Chains are runs. Sections are numbered so code can
cite them.

## L1. Words

Nine words, each with one meaning and one table behind it.

| Word | Meaning | Table |
|---|---|---|
| scope | what a role owns: projects and plans (scopes-and-feed.md F1) | `org_roles.scope` |
| line | the workflow a scope's tasks run on; one per scope; shipped `line` by default | `org_roles.line_workflow_slug`, `workflows` |
| station | a task status. The team's statuses, in order, are the stations | `tasks.status` / `status_id` |
| run | one task's passage along a line | `workflow_runs` |
| gate | a workflow node where a person decides. A gate IS a decision | `session_decisions` with `workflow_run_id` |
| hold | a pending blocking decision bound to a task keeps it at its station | `session_decisions.task_id` + `station` |
| evidence | what a station produced: pages, images, docs, files, a PR, verification text | `artifacts.task_id`, `tasks.*` |
| stack | a person's ordered set of decisions (decisions-as-documents.md D5) | `decision_stacks` |
| hand | a session a run or a role starts for bounded work | `conversations.org_role_id` |

Nothing else is coined. A chain (agent-definitions.md D5) is a linear workflow
and its run is a run.

## L2. A scope owns a line

`org_roles.line_workflow_slug?: string`, default `line`. Resolution, in order:
a path on disk, the caller's own `workflows` row by slug, a shipped template by
name (`packages/cli/src/workflow/templates.ts`). `cast workflow run` with no
file resolves the caller's role line (the session's `org_role_id` or
`standing_role_id`), else `line`. `cast role line <handle> [--set <slug>]`
reads or writes it; the scope page Settings tab has the same picker. A change
is a scope edit: human only, logged to `org_role_history`, and it wakes the
role.

The shipped line: analyze → implement (worktree, three visits at most) →
verify (the repo's check) → review (independent session, sees only the branch,
title and criteria) → exit. Edges route on the task's own fields, refreshed
after every node: `handoff`, `outcome`, `review_verdict`.

## L3. Stations are statuses

A task's stations are its team's statuses in their configured order (the six
defaults plus any custom ones). A run does not add states to a task: node
start and end move the task through its statuses exactly as a hand would by
`cast task handoff` and `cast task verdict`. The task page draws the stations
as a strip with the current one highlighted; under the current station it
shows the run's live node, the hand working it, the elapsed time, and the
review verdict when one exists.

Handoff (`cast task handoff <ct> --status done|blocked|needs_context
--evidence - [--files a,b] [--pr <url>] [--page <slug|url>]...`) writes
`execution_status`, `verification_evidence`, `files_changed`, attaches the
named pages (L6), posts a `review` comment and moves the task to `in_review`.
Verdict (`cast task verdict <ct> approve|changes|reject --note -`) writes
`review_verdict`; approve closes, changes reopens to `in_progress`, reject
reopens as blocked. Independent review (`enforceIndependentReview`,
`tasks.ts`): a session of a role cannot move its task to done without an
approve verdict from a session outside the role.

## L4. A gate is a decision

A `hexagon` node pauses the run and asks a person. The ask goes through the
one rail every human question uses: `session_decisions`. Nothing else asks a
person from a run.

Node attributes on a gate:

```
prompt="..."        the question (first line) and the context (the rest); $vars expand
doc="$review.output" markdown body for the decision document (any $var; optional)
category=review      proposed category (decisions-as-documents.md D1 vocabulary; optional)
```

Graph attribute `stack="Launch checklist"` creates one stack per run on the
first gate and appends every later gate to it.

Edges out of a gate are the options: `[A] Approve :: what happens if chosen`.
The key is the bracketed letter, the label follows, the description follows
`::`. An edge without a label is not an option.

`workflow_runs.pauseAtGate({ run_id, node_id, prompt, choices[{key,label,description?,target}], doc_md?, category?, stack? })`:

1. Picks the asker: `spawner_conversation_id` (the session that started the
   run, or the role's standing session, so the ladder and grants apply), else
   `primary_conversation_id`.
2. Calls `askCore` (`sessionDecisions.ts`) with `task` = the bound task's short
   id, `station` = the task's current status, `options` from the choices,
   `context_md` from the prompt, `doc_md`, `category`, `stack`, `blocking:
   true`, and `workflow_run_id` + `gate_node_id` on the row.
3. Stores `gate_decision_id` and `gate_node_id` on the run, sets status
   `paused`, and posts the `__wf: "gate"` message carrying the decision id.
   `gate_prompt` and `gate_choices` stay as a mirror for old readers.

Answering. Every resolve path (the queue, the document page, the transcript
card, `cast decide answer`, a role under a grant, a stack policy) ends in
`finalizeAnswer`. When the row carries `workflow_run_id`, `finalizeAnswer`
patches the run: `gate_response` = the chosen key (or the typed text), status
`running`. The runner's poll (`pollGateResponse`) reads the run as before. A
gate decision is delivered with `deliver: false`: the run consumes the answer;
the asking session is not messaged.

`respondToGate` (the run panel's free text) answers the decision: a message
that starts with a key picks that option; anything else is `answer_text` and
routes the run on its unconditional edge, as today. `respondToGateFromCli` is
the same call.

Withdraw. `workflow_runs.cancel` withdraws the run's open gate decision.
`withdraw` on a gate decision fails the run with `fail_reason: "gate
withdrawn"`. Both go through `settleResolution` so ladder roles receive the
passive fact.

Failure gates. The runner's existing decisions for a reject verdict and for
exhausted retries (`queueTaskDecision`) carry `workflow_run_id` too, so the
run panel and the task page show them as the run's decisions.

## L5. A blocking decision holds its task

A pending, blocking `session_decisions` row with `task_id` and `station` equal
to the task's current status holds the task there. The status mutations in
`tasks.ts` (the CLI update and the board update) apply one rule before any
status change:

- The actor is a session (any conversation: a hand, a role, a plain agent):
  refused. The error names the decision: `Held at in_review by sd-211: answer
  it first (cast decide answer sd-211 <n>)`.
- The actor is a person on the web: allowed. The decision stays open; the
  mutation adds a `note` comment naming the decision it moved past.
- Server internal patches (a run's node start and end, `pauseAtGate`) are not
  status mutations and are not held.

Answering releases the hold because the row is no longer pending. Nothing is
written to the task for a hold; the task page and list derive "held at" from
the open decisions by `by_task`.

## L6. Evidence attaches at the station

`artifacts` gains `task_id?`, `plan_id?`, `station?` and index `by_task`.

- `cast publish --task ct-N` and `--plan pl-N` set them. Without a flag, a
  publish from a session bound to a task (its active task) attaches to that
  task at its current status. `cast task handoff --page <slug|url>` attaches
  an existing page to the task (patches `task_id` and `station`).
- A decision option may carry a page: `session_decisions.options[i].page_slug`.
  `cast decide --option-page n=file.html` publishes the file (the same path
  `--report` uses) and sets it; the JSON spec accepts `page` per option. The
  document page renders option pages as a comparison row above the option
  list: thumbnail, title, open in a pane, open in full.
- `tasks.evidence({ task_id })` returns one object the task page and `cast
  task show` render: pages by station (with thumbnail urls), docs with the
  task in `task_ids`, images from bound sessions (`conversation_images`),
  `files_changed`, `verification_evidence`, the PR, `review_verdict`.
- Images from `cast image` have no row and attach through the message that
  carries them; a bound session's images are the task's images.

## L7. Chains are runs

`cast exec --chain <name>` and `cast agent run <name>` compile the chain into a
linear workflow (slug `chain-<name>`, one `box` node per step with the step's
prompt template, `definition=` the step's agent), upsert it, create a run with
`createFromCli` (bound with `--task` or `--plan` when given; spawner = the
current session), report each step with `updateProgress` (the step's output
head as `result_preview`), and complete or fail the run. `cast exec -j N`
records one run with a `component` fanout node and one node per input. Step
output still prints to stdout and to `--json` as before. A chain run therefore
shows on `/routines`, on the task page and in the scope feed like any run.

## L8. Runs belong to the workspace

`workflow_runs` gains `workspace` (the ACCESS key, written by
`computeWorkspaceKey` at `create`, `createFromCli` and `ingestSnapshot`) and
`team_id` (routing). Reads go through the data context: a teammate who can
read the task can read its run. `workflow_runs.listRuns({ team_id?, task_id?,
plan_id?, status? })` is the one list for the web feeder, the scope feed and
the task page. Existing rows are backfilled from their owner (personal key).

Node fidelity. `definition`, `reviewer`, `timeout` and `temperature` are
persisted on `workflows.nodes` (schema, `workflows.upsert`, the CLI push) so a
run the daemon executes from the stored graph matches a local run.

## L9. The sweep starts the line

`orgLine.sweep` runs every two minutes. For each active role with trust
`direct`: every task in its scope that is assigned to `agent:<handle>`, has
status `open`, is not blocked and has no `workflow_run_id` gets a run when
`counters.hands < caps.hands_per_day`. The run is created as the role's host
user, with the role's `project_path`, spawner = the role's standing
conversation, and a `daemon_commands` `run_workflow` row for the host's daemon.
The sweep bumps `counters.hands`, comments once on the task, and skips paused
roles. It is idempotent: a task with a run is never started twice.

The sweep and `cast workflow run` create runs through one core
(`workflow_runs.createRunCore`): the run row, the task patched to
`in_progress` with its `workflow_run_id`, the primary conversation and its
started message. The run's access key comes from the task's own `workspace`
(L8), so a task private to its owner inside a team keeps a private run.

The run's workflow is the host's `workflows` row with the line's slug
(`by_user_slug`). When the host has no such row (the slug names a shipped
template nobody has pushed yet) the run carries `workflow_name` = the slug
and no `workflow_id`, and the daemon command's args carry `workflow_slug`.
`cast workflow run-daemon` builds its graph with `graphForDaemonRun`
(`workflow/daemonGraph.ts`): the stored row's nodes when there are any, else
the shipped template that `run.workflow_name` names, the same lookup `cast
workflow run <name>` uses. `cast role line --set` refuses a slug that is
neither a shipped template nor a pushed workflow, so a run is never parked on
a name nothing can execute. The run's primary session is a hand of the role
(`recordHandStart`): it carries `org_role_id` and is the one that counts
against `caps.hands_per_day`.

## L10. Surfaces

Task page. The station strip (L3) at the top; a held marker on the current
station linking the decision (L5); Decisions: open cards, answered ones
folded; Evidence (L6) grouped by station with page thumbnails; the run panel,
whose gates render the decision card, never their own buttons. The task list
shows a station or run chip.

Decision page. Gate decisions show a run chip (workflow, node) and the node's
inputs in the body; option pages render side by side (L6). The transcript
card and the stepper carry `kind`, `form`, `body_md`, `cost`, `risk`,
`evidence`, `category` and `page_slug`, and render the right controls or link
to the page.

Queue and stacks. Gate decisions are ordinary cards with a run chip.
`/decisions/stacks` lists stacks (open and done, progress, due). A stack
policy gains `due_at`; `cast stack policy --due <when>`; the queue shows due
on the group header and sorts overdue first.

Scope page. A Line tab: one column per station, task cards with the run's
current node, the hand's state stripe, a held marker and an evidence count.
Settings: the line picker (L2). The feed renders `run` rows. The Decisions tab
lists stacks and the role's ladder rows.

Routines. `/routines` gains a Runs tab across workflows (L8) with status,
task, current node and gate; its gate panel renders the decision card. One
Workflows entry in the sidebar and the user menu, pointing at `/routines`,
with a Dynamic tab that hosts the `/workflows` dashboard.

CLI. `cast task show` prints decisions (id, status, station), runs (status,
node, gate) and evidence. `cast workflow runs [--task|--plan]`. `cast org feed`
prints run rows. `cast stack remove ds-N sd-N`, `cast stack reorder ds-N
sd-a,sd-b`, `cast decide ls --mine`. `cast decide edit` accepts every ask
field.

## L11. Limits

Hands started by a run are unattended principals: reversible actions run;
anything in a protected category goes through `cast decide`, which pins the
holder to a person. A stalled hand is killed by the runner's timeout and the
task returns to open with a comment. Two implement cycles, then the task goes
to `in_review` blocked with a decision to the person (L4, failure gates).

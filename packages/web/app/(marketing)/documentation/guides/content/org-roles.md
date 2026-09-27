A session is one conversation with one agent. It starts, does a piece of work, and ends. That makes a session a poor address for work that lasts. A message sent to a session is lost when the session closes, and nothing says which of forty live sessions answers for the billing code.

Codecast models the agents and people around a body of work as an organization. A **role** is a named seat in a reporting tree. It has a **scope** (the projects and plans it owns), a charter that people write, a brief that the role writes, and one standing session that checks the scope on a schedule and answers what people send it. The role is a row in `org_roles`. The session is replaceable: restart it or seat a different session, and the role keeps its scope, its brief, its tasks and its place in the tree.

So work routes to the responsibility instead of to whichever session is running. Assign a task to `@growth`, mention `@growth` in team chat, or send it a message, and the message reaches the session that holds the seat today.

```bash
cast org ls                          # people, roles with their scopes, the sessions under each
cast org feed @growth                # everything in the scope, newest first
cast org health                      # load, flags and stale records for each role and person
cast role show @growth               # seat, trust, caps, today's counters, hands
cast role wake @growth "The pricing page is live; check the funnel"
cast brief @growth                   # live facts about the scope, what changed, the role's narrative
cast role pause @growth              # its triggers pause, hands stop at a safe point (resume, restart)
cast task ls --assignee @growth      # the tasks the role answers for
cast task ls --chain me              # everything in your reporting chain
```

## Role, standing session, hand

| Object | What it is | Where it is stored |
|--------|------------|--------------------|
| Role | A seat: name, handle, scope, who it reports to, trust stage, daily caps | `org_roles`, short id `or-N` |
| Standing session | The one conversation that speaks for the role | `conversations.standing_role_id` |
| Hand | A session a role or a run starts for one bounded piece of work; it reports to the role | `conversations.org_role_id` |
| Charter | The job, written by people. A session of the role cannot write it (`docs.refuseRoleCharterWrite`) | a doc of type `charter` |
| Brief | The role's memory. `cast brief edit -` writes it, and its first line becomes the standing session's [pinned state](/documentation/thread-state) | a doc of type `brief` |

A session that reports to a role still has its owners; the role sits between the session and the person. In the host's inbox such a session nests under the role's card and does not count toward the host's needs input. The role reads it first. `cast escalate <session> "<one line>"` puts it in front of the person with the role's reason, and `cast escalate --clear <session>` takes it back. A hand cannot escalate itself.

Three trust stages gate what a role may do, and the server checks them. At `understand`, the stage every role starts at, the spawn path refuses a hand: "may not start hands". `decide` lets the role answer decisions inside its grants. `direct` lets it start hands inside its caps. The default caps are 6 hands, 40 wakes and 400,000 tokens a day (`DEFAULT_ROLE_CAPS`). Token use is counted from Claude transcripts only; the brief reports sessions on other backends as uncounted.

## The tree and scopes

A role reports to a person or to another role (`reports_to`). A move that would make a cycle is refused. `cast org reparent <session> --to @handle` files a session under a role; moving a role is a staffing change, made on the org page. Each move tells a moved session once: it receives "You now report to <name>". A moved role reads its new line in `cast brief`.

A scope is `{ project_ids, plan_ids }`. Two empty lists mean the whole workspace. A task is in scope when its project is listed, its plan is listed, or its plan's project is listed. A session is in scope when it is bound to such a task or plan, when its project path equals a scope project's path, or when it reports to the role. A child's scope must fit inside its parent's unless the parent looks after the whole workspace; the server refuses the edit and names what falls outside. Two sibling roles may watch the same project, and the pages show that as a warning.

When a role gains scope, the host's sessions in that scope that report to no role move under the role in the same write, at most 100 at a time. `--leave-sessions` keeps them where they are. A project names its lead in `projects.owner_role_id`.

## How a role is woken

A role is a session, and it wakes the way any session wakes: on its own trigger, and when someone writes to it.

Every role has one recurring [trigger](/documentation/triggers) on its standing session, armed when the role is brought online: a daily check for a role, the weekly company review for the chief of staff. It appears on the Triggers page and on the role page's Triggers tab with its next run, and you change or pause it there like any trigger. Pausing the role pauses every trigger on its seat; resuming brings them back. The check's prompt is short: run `cast brief`, act on what your switch and grants allow, put in front of the person what needs them.

Everything else reaches the role as a plain message into its standing session, never wrapped or held:

| Event | Arrives as |
|-------|-----------|
| A person messages the role: `cast role wake`, `cast send @handle`, the composer on the role page | the message, as written |
| `@<role handle>` in team chat, from a person or from a session | the same chat mention line a session gets |
| A decision was routed to the role | one line naming the decision |
| A hand needs input, or pinned `--status blocked` | one line naming the hand |
| A task is assigned to the role | one line naming the task |

A change in the role's area wakes nothing. A task or plan in scope moving, a hand settling done, a decision being answered, an edit to the charter, the scope, the line or the reporting tree: the role reads all of it at its next run. `cast brief` carries a "changed since" section clocked on the last time the role read its brief from its own session, so each run sees what moved since the one before.

## Hiring and proposals

Staffing is a person's act. `orgRoles.create`, `reparent`, `retire` and the scope, charter, line, switch and limit writers all pass `refuseUnlessHuman`: the call must carry a browser sign in and no API token. The CLI has the verbs (`cast role create`, `cast role autonomy`, `cast role limits`, `cast role scope`), and the server answers a shell with "human only: make them from the role page in the browser". An agent proposes; a person accepts on the org page.

**The hire form.** "Add a role" on `/org` and "Add a lead" on a project with no lead open one dialog. It previews what the seat will read, proposes a charter from the projects picked, and says the role starts work on its own; the switch and its limits live on the role's page. Submit creates the role and provisions its standing session.

**`cast org init`** spawns an analyzer session (`--here` prints the prompt for the current agent). The prompt tells it to read `cast org inputs` and `cast org health`, then each git root, and to read activity before records: where the commits and sessions are is the ground truth, and every plan, task and project is a claim to check against it. Anything it could not read is reported as "could not verify". An empty company yields one intake role, never invented work. A session older than a week that already behaves as a role can be proposed with its own history as the seat. `cast org review` runs the same prompt against an existing chart, and the `cast-org` skill holds the same conversation inside a session.

**A proposal** (`op-N`, table `org_proposals`) is a list of changes, each with a rationale and evidence links: role, move, retire, scope, budget, trust, routine, adopt, project fields, and status fixes that bring stale plans and tasks in line. Open changes draw on the chart as dashed ghost nodes with Accept, Edit and Skip. An accepted change applies at once through one apply core, in a fixed order with record fixes and projects first, then roles with parents before children. `decide` and `acceptAll` refuse any call with a token or a session. The author can still change an open proposal with `cast org revise op-N --remove|--amend|--add`; a change a person already decided is refused by name. `cast org apply op-N` prints the changes and the page link, and applies nothing.

**Templates.** `cast org template install <folder> --instance <name> --project <id> --team <id>` validates a release folder (`org-template.json`: one role, its charter, caps and up to 50 routines), pins a snapshot with a SHA-256 digest, and posts one role proposal. `reconcile` applies the person's answer, provisions the seat at `understand`, and creates each routine paused behind a temporary precheck. The CLI never resumes one; a person activates each routine. The receipt lives at `<project>/.codecast/org-templates/<instance>.json`. If a create may have reached the server and no row proves it, the command stops instead of risking a second role. In the hire dialog the "From a folder" tab builds this install command for you to copy.

## Staffing and capacity

One role is one context window, so the thresholds that size a seat live in one module, `packages/shared/contracts/orgCapacity.ts`, read by the health query and rendered into the analyzer prompt. Load is what reaches the role: 30 work items a day, 4 routed decisions a day, 6 live hands, 3 open stalls. The ledger is what the scope holds (25 open tasks, 8 in flight, 4 active plans). Only load raises `overloaded`. A wide ledger raises `wide_ledger` and never drives a split.

`cast org health` prints the flags for each role: `overloaded`, `bypassed` (work closes in the scope and none of it reaches the seat), `idle` after 14 days, `review_stall` after 24 hours in review, `cap_hit`, `stale_plan`, `stale_task`, `program_ended`. A person with more than 7 direct roles raises `wide_span`. `cast org staff` hires the Chief of Staff (handle `chief-of-staff`): a role over the whole company with a `cast org review` routine every 7 days that posts proposals. It is safe to run twice.

## The line

The **line** is the [workflow](/documentation/workflows) a role's tasks run on, stored as `org_roles.line_workflow_slug` with the default `line`. A **station** is a task status: a run adds no states, it moves the task through its team's statuses. `cast role line @handle` prints the slug. `--set <slug>` refuses a slug that is neither a shipped template (`line`, `feature`) nor a workflow you pushed, and the server then applies the same rule that governs every scope edit, so the change is made on the Settings tab of the role page.

The shipped line is analyze, implement, verify, review. Each agent node has `backend=session`, so every station is a codecast session you can open, `cast read` and `cast send`. Implement runs in its own worktree, three visits at most. Verify runs `cast ws check`. Review is a fresh session that receives only the branch, the title and the criteria.

Stations pass work with structured commands instead of prose, and the edges route on the fields those commands write:

```bash
cast task handoff ct-4102 --status done --evidence - --files a.ts,b.ts --pr <url> --page <slug>
cast task verdict ct-4102 approve|changes|reject --note -
```

`handoff` writes `execution_status`, `verification_evidence` and `files_changed`, attaches the named [published pages](/documentation/publish) to the task at its current station, and moves the task to `in_review`. `verdict` writes `review_verdict`: approve closes the task, changes reopens it to `in_progress`, reject reopens it as blocked.

**A verdict is a record, never a gate.** Who closes a task does not decide whether the close is allowed; a role closes the tasks in its own scope like anyone else. One rule holds a task in place: a pending blocking decision bound to the task at its current station refuses a status change from any session, and a person on the web may move past it.

`orgLine.sweep` runs every two minutes. For each active role at `direct` trust, it starts a run for each open, unblocked task in scope whose assignee is `agent:<handle>` and that has no run yet, while today's hands are under `hands_per_day`. One sweep starts at most 10 runs. A task leaves `open` when its run exists, so it never starts twice.

## The unattended contract

A hand on the line runs with nobody watching, and it launches with the same permissive flags as every session the daemon starts. The fence is one briefing, `UNATTENDED_MANDATE` in `packages/shared/contracts/unattended.ts`, placed ahead of the first prompt by `cast spawn --unattended`, by every session node of a workflow, and by the server when a role starts a hand. It states five rules: reversible actions run without asking; anything in a protected decision category (production, billing, data, access, external, product) goes through `cast decide` and waits; the task branch is the hand's own to commit and push; no inline questions; end the turn with the structured command the briefing names. This is an instruction, not a sandbox.

A session node that passes its timeout (30 minutes by default) is killed and the node fails. When a review rejects the branch or the retries run out, the runner queues a decision to the person instead of looping.

## On the web

`/org` draws people, roles and sessions as one tree. Each session card carries its inbox work state, and a wide cluster folds into a "+N sessions" card. Drag a session or a role onto a person or a role to reparent it; a popover confirms the move. The staffing pane lists the company's flags, the changes of the open proposal, and a composer that talks to the chief of staff.

`/org/<or-id>` is the scope page. The role's standing conversation fills the left side, so there is one place to type, and a line sent there is the same pending message `cast role wake` enqueues. The panel beside it has the tabs Scope, Feed, Tasks, Line, Plans, Docs, Sessions, Decisions, Brief, Charter, Triggers and Settings. Line shows one column for each station. Sessions groups hands by who acts next. Settings holds the scope editor, trust, caps and the line picker.

Roles build on [tasks and plans](/documentation/tasks-and-plans), hear from people through [messaging](/documentation/messaging), and wake on their own through [triggers](/documentation/triggers). For a plan driven once by a conductor instead of a standing seat, see [orchestration](/documentation/orchestration).

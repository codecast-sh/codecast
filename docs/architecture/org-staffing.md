# Staffing: the company model, the chief of staff, and proposals on the chart

Builds on org-roles.md, org-roles-standing.md, org-init.md, scopes-and-feed.md.
The org already runs. This layer designs it and keeps it flowing: an agent reads
how work moves, proposes the organization as ghost nodes on the org page, and a
person accepts, edits or skips each change. The same agent can hold a standing
role, the Chief of Staff, with a routine that reviews the company on a cadence.

## S1. The company model

The words the product uses, on every surface and in every prompt:

| Word | Meaning | Row |
|---|---|---|
| Company | The workspace (a team, or a person's personal workspace) | teams / users |
| Executive | A person. Owns budget, answers decisions, hires roles | users |
| Manager (role) | A standing agent with a scope, a charter, a brief, a budget | org_roles |
| Contributor (hand) | A session doing one piece of work; transient | conversations |
| Business line (project) | A lasting area of work with a charter | projects |
| Program (plan) | A bounded effort under a project with a goal and criteria | plans |
| Budget | Daily caps on a role (hands, wakes, tokens); rolled up the line | org_roles.caps |
| Staffing | Which roles exist, their scope, who they report to, their budget | org_proposals |
| Chief of Staff | The role that reviews the company and proposes staffing | org_roles (handle chief-of-staff) |

A proposal is staffing and budgeting in one: it moves scope, people and budget.

## S2. The capacity model

One role holds one context window. Its frame is capped (3000 characters of
facts) and its brief is short, so what flows into a seat must fit in what one
agent can hold in its head between wakes. The thresholds live in ONE module,
`packages/shared/contracts/orgCapacity.ts`, read by the server health query and
rendered into the analyzer prompt (`renderCapacityModel`, which also carries
the guidance on how to read and size with the numbers), so the product never
argues with itself.

Load and ledger are two different things. A role does not do its scope's
tasks; hands and people do. What loads a role is what reaches it and asks for
its attention. What its scope holds is context: it says how much the frame
lists before it overflows into counts, and a ledger far over the line is a
records problem (stale rows, unfiled plans) or a filing seam before it is a
seat problem. The overloaded flag reads the load only; the ledger gets its own
information flag (`wide_ledger`) and never drives a split.

```
ROLE_CAPACITY = {
  // the five load axes the overloaded flag reads
  items_per_day: 30,       // distinct tasks and plans in scope that changed, per day over 7 days: one frame line each
  decisions_per_day: 4,    // decisions routed to the role, per day over 7 days: an immediate wake each
  live_hands: 6,           // equals the default hands cap
  open_stalls: 3,          // review stalls + hands that reported blocked or needs context this week
  cap_hit_days: 1,         // days in the last 7 at the wake or token cap; more than one is a pattern
  // the other thresholds, each its own flag
  direct_reports: 5,       // child roles
  wake_load: 0.7,          // wakes today or 7 day average over cap
  token_load: 0.8,
  decision_latency_min: 5, // ask to recommendation, the hop deadline
  review_stall_hours: 24,  // a task sitting in in_review
  idle_days: 14,           // no scope event
  peer_sends: 5,           // sends between two roles in 7 days, when they outnumber the work done
}
ROLE_LEDGER = { open_tasks: 25, in_flight: 8, active_plans: 4 }   // what the frame lists individually; context, never load
PERSON_SPAN = { direct_roles: 7 }   // above this, propose a layer
STABILITY = { move_cooldown_days: 7, split_after_breaches: 2, split_on_first_breach_ratio: 2, retire_after_idle_days: 14 }
```

`overload_ratio` is the busiest VOLUME axis (items a day, decisions a day,
live hands) divided by its line; at `split_on_first_breach_ratio` a split
waits for no second review. Stalls and cap hits are symptoms, not volume:
they breach (a warning, a blocker with a second axis or a second review) but
never make a structural split on their own, and the ledger never does.

The numbers are defaults with a reason each (in the module). The analyzer
reasons with them; it may argue for an exception in its rationale.

Measured against the Codecast workspace on 2026-09-16, the day the model was
revised: the seat the old ledger model told to split twice over (@product, 63
open and 24 in flight in the health count) had 0 hands, 0 decisions, 0 stalls,
0 cap hits and about 20 items changing a day; under the load model it is inside
the model with a wide ledger, which is what a person reading the evidence
concluded.

## S3. Flow signals: org.health

`org.health({ team_id? })` returns, per role, per person and for the company,
the signals the capacity model needs and a list of flags. Computed on read
from the same scan org.tree uses plus: role_wakes and org_roles.counters
(spend), session_decisions hops (latency, escalations), tasks by status and
updated_at (in flight, review stalls, throughput), the pending_messages ledger
between standing sessions (who talks to whom; sessionThreads parses it), chat
mentions of roles, org_role_history (last move), file of tasks with no
project (unfiled) and projects with no owner role (unowned).

```
org.health → {
  roles: [{ role_id, short_id, handle,
            load: { items_per_day, decisions_per_day, live_hands, direct_reports, open_stalls, cap_hit_days },   // what reached the seat this week
            ledger: { open_tasks, in_flight, active_plans },                                                   // what the scope holds today; context
            counted: { rule: "scope" | "remainder", projects, plans, tasks, complete, note },                 // which rows, by what rule
            overload_ratio, breaches, overloaded_now,
            spend: { wakes_today, wakes_7d_avg, wakes_cap, tokens_today, tokens_7d_avg, tokens_cap, cap_hits_7d },
            flow: { decisions_7d, items_changed_7d, median_recommend_min, escalations_7d, frames_dropped_7d, done_7d, handoffs_7d: { done, blocked, needs_context }, review_stalls, sends_7d: { to: [{ role_id, n }], from: [...] } },
            last_move_at, idle_days, flags: Flag[] }],
  people: [{ user_id, direct_roles, decisions_waiting: { n, oldest_min }, flags }],
  company: { unowned_projects: [{ id, title }], unfiled_tasks, plans_without_goal: [...], projects_without_charter: [...], flags },
  generated_at }
Flag = { code: "overloaded" | "wide_ledger" | "wide_span" | "idle" | "slow_to_recommend" | "review_stall" | "cap_hit" | "unowned" | "no_charter" | "chatter" | "unfiled_plan" | "stale_plan" | "stale_task" | "stale_project" | "program_ended", severity: "info" | "warn" | "blocker", detail }
```

A role's rows come from the ONE scope rule the scope feed, the scope page and
the task list read (`org.resolveScope`): the scope's projects, its named plans
plus every plan of a scope project, and every task filed under either. Health
evaluates that rule over the workspace's complete open set rather than by a
second index read per role (the same rows at a fraction of the read budget;
Convex allows 4096 rows per function). A whole workspace role holds the
remainder no narrower role covers. `counted` says which of the two a row used
and how many projects, plans and tasks it read, so health and the task list
cite the same rows and a reader can tell when a count is a floor. The CLI
reads health through `healthReport`, an action that gives the decision
ladder and the task read (`healthWorkPart`) their own query budgets before
the core part runs.

Health and the analyzer inputs read tasks through one reader
(`orgHealth.readWorkTasks`): every OPEN row of the workspace, one status index
read each (`scopedFetch` with `status`), plus the rows updated inside the
window (`updatedSince`), and real work only (`shared/tasks` `isActiveTask`: a
mined suggestion awaiting triage or a dismissed one is not a claim anyone
filed, so it is neither ledger, nor load, nor unfiled, nor a record to bring
in line). A workspace-wide "newest N" read is the wrong shape for this: on
the Codecast workspace the newest 2000 rows were mostly suggestions and
closes, only 11 of the 120 quiet in-progress rows reached the stale detector,
and 142 of the 157 rows it did flag were suggestions. Rows closed before the
window are not read, so `tasks.by_status` counts done and dropped inside the
window only and says so; a status slice at its cap is reported as a floor.

`cast org health [--json]` prints it. The org page shows a small flag badge on
a node with the detail on hover; the staffing pane lists the company's flags.

## S4. Proposals

A proposal is a structured set of changes with a rationale each, authored by an
agent (the chief of staff, an analyzer run) or a person, decided change by
change.

```
org_proposals        short_id "op-N", team_id? | scope_user_id? (boundary, anchor style), author: { kind: "role" | "session" | "user", id },
                     title, summary_md, mode: "init" | "review" | "request", status: "open" | "resolved" | "withdrawn",
                     evidence_doc_id?, created_at, resolved_at?
org_proposal_changes proposal_id, seq, change: OrgChange, rationale, evidence: { label, href }[], expected_effect?, risk?,
                     status: "proposed" | "accepted" | "skipped" | "applied" | "failed", edits?: json, decided_by?, decided_at?, applied_note?, applied_at?
OrgChange = the existing contract kinds (role | projects | move | retire) plus:
  { kind: "scope", handle, add?: refs[], remove?: refs[] }
  { kind: "budget", handle, caps: { hands_per_day?, wakes_per_day?, tokens_per_day? } }
  { kind: "trust", handle, trust }
  { kind: "routine", handle, title, prompt, every: "7d" | "1d" | ... }
  { kind: "project_meta", project: ref, goal?, success_metrics?, priority?, owner?: "@handle", non_goals?, risks? }
  { kind: "adopt", handle, conversation: short_id }   // this session becomes the role's standing session
```

Mutations (`orgProposals.ts`): `create` (from the CLI with a spec, or the web),
`decide({ change_id, verdict: "accept" | "skip", edits? })`, `acceptAll`,
`withdraw`. Deciding is browser only: `decide` and `acceptAll` refuse any
call that carries an API token or a session (the same `refuseUnlessHuman`
gate as trust, caps, scope and charter), so a hand or a shell can never accept
a staffing change. Accepting applies at once through the one apply core in
orgInit.ts (applyRole, applyProjects, applyFile, applyMove, applyRetire,
applyScope, applyBudget, applyTrust, applyRoutine, applyProjectMeta,
applyAdopt) with `human_decision` from the signed in user. A thrown apply
discards its writes and leaves the change decidable; a refusal the core
returns lands as `failed` and stays decidable. A proposal resolves only when
every change is applied or skipped, and its queue card waits with it.
Ordering: projects first, then roles (parents before children), then moves,
scope, budget, trust, routines, adopt, retire; accept all follows it.

The queue: creating a proposal inserts one advisory decision for the person
it addresses ("Chief of Staff proposes N changes", link `/org?proposal=op-N`,
default "review on the org page"); answering it does nothing but clear the card.
The existing decision stack path (`cast org init`, templates) stays; `cast org
init` and `cast org update` now write a proposal and print its short id, and
`cast org apply op-N` prints the proposal and the page link, since a shell
cannot decide. The stack
apply (`ds-N`) keeps working for stacks already created.

## S5. The org page: ghosts and the staffing pane

Ghosts. Open proposal changes render on the chart merged into the layout:

- role: a ghost node under its proposed parent (dashed border, 55% opacity, the role's handle, scope chips, a "proposed" tag).
- move: a dashed edge to the new parent; the old edge at 30% opacity.
- retire: the node with a hatched overlay and a "retire" tag.
- scope, budget, trust: a dashed chip on the node ("+ project X", "tokens 400k to 800k", "trust to decide").
- routine: a dashed clock chip on the node.
- project_meta: a dashed chip on the scope panel's project row.
- adopt: a ghost node marked "this session" when the viewer is looking from the session that offered.

Every ghost carries an action row: Accept, Edit, Skip. Edit opens the hire
dialog prefilled (role) or an inline form (the others). Accept is optimistic:
the change flips to accepted in the store and the tree draft gets the stub
(a created role stub keyed by the change id, superseded when org.tree echoes;
a move re-parents the row; a retire hides it) with a dispatch side effect to
`orgProposals.decide`. Skip greys the ghost and drops it on the next layout.

The staffing pane (the right sheet, a "Staffing" mode of the existing panel):
header (proposal title, author, age, N of M decided), the company's flags
(bottlenecks and span of control, each linking to its node), the change list
(status, one line, accept/edit/skip, click to focus the ghost), the rationale
with evidence links for the selected change, "Accept all remaining", and a
composer that talks to the chief of staff's standing session (a send through
the existing pending message rail; the thread renders below the composer
through the embedded conversation view). With no open proposal the pane shows
the health summary and the composer. With no chief of staff it shows two
buttons: "Hire a Chief of Staff" and "Propose an org now".

Phone: the pane is the bottom sheet; ghosts render the same.

## S6. The Chief of Staff

`orgRoles.staff({ team_id?, reports_to?: user, adopt_conversation_id? })`:
creates the role (name "Chief of Staff", handle `chief-of-staff`, scope the
whole company, reports to the hiring person, trust understand, charter from
the template below), provisions its standing session (or adopts the given
conversation: sets standing_role_id and persistent on the existing row and
creates the anchors row pointing at it), arms one routine on the standing
session ("Company review", every 7 days, prompt: run `cast org review`), and
runs the first review at once. Idempotent per company. `cast org staff
[--adopt] [--every 7d]` is the CLI; "Hire a Chief of Staff" is the button.

The charter (principle level, in orgRoles.ts next to the role charter
template): you are the chief of staff of this company; the executives decide,
you propose; read how work flows before you touch the chart; the capacity
model and the stability rules; propose the smallest change that removes a
bottleneck; every change carries evidence a person can click; never apply;
write for a founder who reads it on a phone; escalate anything about budget
or people to the person you report to.

Trust never rises above understand for the chief of staff: it applies nothing.

Seating (S12, S16) as shipped: `staff` also takes `seat: "existing" | "fresh"`
(default existing when a standing agent exists, else a fresh session is
provisioned). `existing` adopts the workspace anchor's conversation: the
anchors row gains `org_role_id`, the conversation gains `standing_role_id`,
its title becomes the role's name (the old one kept in
`conversations.seat_previous`), and the seating note lands from the acting
person ahead of the briefing (`seatingNote`). `fresh` retires the old standing
agent in the same act and links its thread from
`org_roles.previous_standing_conversation_id`. The result adds `seated`,
`conversation_short_id`, `previous_title` and `previous_standing`. `retire`
takes `standing_session: "keep" | "retire"` (default keep for the chief,
retire for other seats); keep clears the role pointers, restores the title and
leaves the anchor answering as the workspace's standing agent. The result
carries `standing_session: "kept" | "retired" | "none"`.

## S7. Charters on projects and plans

Higher level agents need higher level direction. Projects and plans gain:

```
projects  + goal?: string, success_metrics?: string[], priority?: "p0" | "p1" | "p2" | "p3",
            owner_role_id?: Id<org_roles>, non_goals?: string[], risks?: string[],
            budget?: { tokens_per_day?, hands_per_day? }
plans     + success_metrics?, priority?, owner_role_id?, non_goals?
```

CLI: `cast project update <ref> --goal - --metric "..." (repeatable) --priority p1 --owner @handle --non-goal "..." --risk "..." --budget-tokens N`; `cast plan update` takes the same flags. Web: a Charter block at the top of the project page and the plan page (goal, metrics as a checklist, priority pill, owner role chip linking to /org/or-N, non goals, risks; each editable inline through the store). The role frame's "Your scope now" section and the brief's fact block lead with each project's goal, priority and metrics, so a role directs its hands toward the goal rather than the task list. The analyzer proposes charters where they are missing (project_meta changes) and never invents metrics it cannot ground in the project's own tasks and docs.

## S8. The analyzer prompt

`packages/cli/src/orgInit.ts` holds the prompt as an exported template, tested.
It is written at principle level and says:

- The company framing (S1) and that staffing is budgeting.
- What to read: `cast org inputs --json`, `cast org health --json`, each git root's layout, the project charters, the roles' briefs.
- The capacity model (S2, rendered from the shared module) and how to size a scope so one agent can hold it; how to decide when a role needs a report, when a person needs a layer, when a role should be split or merged, and when a project needs an owner.
- How to design from scratch: start from business lines and their goals, name an owner per line, check span, allocate budget from the person's total, size every role against the model, and explain every role with evidence (counts, session titles, commits) or propose an intake draft instead of inventing work.
- How to review: read the flags, the chatter graph, decision latency, review stalls, unowned and unfiled work; propose the smallest change that removes the bottleneck; respect the stability rules; say what you expect to change and how you will know.
- How to write: a proposal spec (`cast org propose --spec proposal.json`) with a rationale, evidence links, expected effect and risk per change; a summary a founder can read on a phone.
- The honesty rules (empty project: intake draft; inaccessible: could not verify; no manufactured tasks) and what to escalate.
- When no chief of staff exists and the company has two or more roles or three or more projects, offer an adopt change: this session becomes the chief of staff.

The prompt is graded, not just tested: a real run on this workspace, scored by reviewers against a rubric (grounded evidence, span within model, budgets sum, smallest change, no invented work, readable on a phone).

## S9. Ground in what is happening, not in what was filed

Plans go stale and tasks finish without being closed. The analyzer treats
every plan, task and project as a claim to verify against what the code and
the sessions say, and proposes to bring the records in line before it
proposes staffing.

`org.analysisInputs` gains an `activity` block, read from the commits table
(30 days, by repository), file_touches and the org scan:

```
activity: {
  areas: [{ repository, path_prefix (a package or top level directory, from the files each commit touched), commits_30d, authors: [{ name, commits }], sessions_30d, project_id? (by project_path or git root) }],
  people: [{ user_id, name, areas: [{ path_prefix, commits, sessions }] }],
  commits: { total, with_files, without_files, spanning_areas },   // how many commits carried a file list; the rest land on "" and are could-not-verify
  stale: {
    plans: [{ short_id, title, status, last_task_activity_at, sessions_live, reason: "every task closed" | "no activity 21d" | "bound sessions all done" }],
    tasks: [{ short_id, title, status, last_session_activity_at, reason: "in progress, no session 14d" | "in progress, sessions done 14d" | "commits landed, still open" }],
    projects: [{ id, title, reason: "no activity 30d" }]
  }
}
```

An area is derived from the files a commit touched (`commitAreaPrefixes`):
the deepest directory every file shares, reduced to the package or top level
area it names; a commit that spans packages lands on each area it touched. The
file list comes from the push webhook (the payload's added, modified and
removed names) and from the checkout mirror (`git log --numstat`, names and
line counts); rows written before either stored files land on the root and
are counted in `commits.without_files`, which the analyzer reports as could
not verify rather than as work on the root.

The stale rules, in the order they are tried. A plan (active or draft) with
tasks: every task closed; else its open tasks untouched for 21 days and no
live session bound to it, whether or not it ever had one; else its bound
sessions all done and its tasks quiet for 14 days. Recent task activity
overrides the session signal: a plan whose tasks moved this week is live
whatever its sessions say. A plan with no tasks is an idea, never stale here.
A task still open: a landed commit carries its id; else in progress with no
session bound and no write for 14 days (filed in bulk, never picked up); else
in progress with every bound session done and no write for 14 days. A project:
nothing touched it for 30 days.

Health raises `stale_plan`, `stale_task` and `stale_project` flags (info) and
the analyzer prompt says: read activity first; a plan or task whose evidence
says it is done is a sync change, not a bottleneck; scopes follow where the
commits and sessions are, and a project whose path nobody touches is not a
seat; bring the records in line first, then size a seat on the load that will
reach it. New change kinds, applied through the existing update paths:

```
{ kind: "plan_status", plan: ref, status: "done" | "abandoned" | "active", reason }
{ kind: "task_status", task: ref, status: "done" | "dropped" | "open" | "backlog", reason }
{ kind: "project_status", project: ref, status: "paused" | "done" | "active", reason }
```

Accepting a plan_status of done or abandoned closes the plan's still open
tasks in the same apply, through the one task path (`setTaskStatus`: the
team's status vocabulary, the independent review rule, bound sessions
released, plan progress reconciled); they are dropped, never done, and the
applied note lists them. The analyzer therefore proposes one change per plan
and names a task on its own only when its evidence differs from its plan's.
`task_status` ranks before `plan_status` so a task the proposal marks done
lands before the cascade reads its plan. `open` (and `backlog`, a status
category of every board) puts a row marked in progress but never worked back
where it belongs instead of dropping real backlog. The three kinds rank
before `projects` in the apply order, and the pane groups them under "Bring
records in line" at the top of a proposal. `cast org update` proposes them on
every review.

## S10. Standing and program roles

A role is either standing (an area that outlives any plan: a business line,
a platform) or a program (a bounded effort with an end: one plan, a dated
push, a migration). The analyzer decides which with reasoning, and says it:

```
org_roles.tenure?: { kind: "standing" } | { kind: "program", ends: { plan: Id } | { project: Id } | { date: number }, then: "retire" | "review" }
projects.horizon?: "ongoing" | "bounded"
```

A program role's end condition is a health signal: when its plan is done, its
project done or its date past, health raises `program_ended` and the next
review proposes the retire (or the review, when `then` says so). The hire
form, the org node (a small "program · ends with pl-N" chip), the scope page
header and the role change in a proposal all carry tenure. The prompt's rule:
when in doubt, a program; converting a program to standing later is one
edit, retiring a standing seat that should have been a program is a week of
wakes.

## S11. Reporting line edits are one gesture, everywhere

The session ownership menu (take ownership, add an owner, run on a device) is
the same act as dragging a session on the org chart: it changes who the
session reports to. One core (`orgRoles.performReparentSession`) serves both
the org page and the ownership menu; adding an owner re-homes the session
under that person on the chart and clears its role pointer; choosing a role
files it under the role. Every reparent, of a session or a role, tells the
agent: a session receives one message ("You now report to <name>. <note>"),
a role receives an immediate wake with the same line, and its hands get a
passive fact. The web shows one toast that says both things ("jx7abc now
reports to Samvit; the session was told"), and the chart moves the node in
the same tick through the org intent journal.

## S12. The Chief of Staff is the workspace's standing agent

The word anchor leaves the product. The workspace's root standing agent is
the Chief of Staff: `cast org staff` adopts the existing anchor conversation
as the chief's standing session when one exists, so nothing restarts and
the Slack binding, `@anchor` in chat and `cast anchor say` keep working as
aliases of the chief (`@chief-of-staff`). The org page draws the root seat as
"Chief of Staff"; `/anchor` redirects to its scope page; the anchors table
stays as the implementation detail it is. Coalescing default is two minutes.

## S13. Personified roles

Long lived roles get a face. A set of tasteful, whimsical animal profile
icons (24 SVGs, two tone on a soft round ground, one style) lives in
`packages/web/components/org/avatars/` with the key list in
`packages/shared/contracts/orgAvatars.ts`. `org_roles.avatar?: key`. The
hire form offers the set (a default derived from the handle so every role has
one); the org node, the scope page header, the chat role pill, the wake card
header and a proposal's ghost seat all draw it; a display name may differ from
the handle and both show.

## S14. First open

The first time a person opens /org (no roles in the workspace and the
`org_nux_seen` pref unset) the page opens on a three step guide over the real
canvas: who reports to whom today (their own node highlighted), what a role is
and how to hire one, how proposals arrive as ghosts and the two buttons that
start one. Each step is one sentence and one highlight; the last step's
buttons are the real "Hire a Chief of Staff" and "Propose an org now". The
guide can be dismissed and never returns; a "How this page works" link in the
toolbar reopens it. The empty workspace canvas is designed, not blank: the
person's own node, the two buttons, one paragraph.

## S15. Where a proposal came from

Every proposal names its author as a pill: a session (title, short id, opens
the conversation) or a role (name, avatar, opens its scope page). The pane
header, the queue card and the analyzer's summary page all carry it.

## S16. Seating the workspace's standing agent is an explained moment

One workspace has one root standing agent. It used to be called the anchor;
its job is now named Chief of Staff. Hiring must never feel like a takeover of
a thread the person already talks to, so the transition is explicit, announced
and reversible.

**The hire form names what will happen.** When a workspace already has a
standing agent, the form opens on that fact: "This workspace already has a
standing agent, <name> (thread jx7abcd, N messages). Seating it as Chief of
Staff keeps its memory, its chat handle and its Slack binding, and adds the
weekly company review to its job." Two choices, the first selected:

- **Seat the existing agent.** No restart, no second session.
- **Start a fresh session.** The old agent is retired in the same act, with
  its thread kept and linked from the new role's page, so a workspace never
  ends with two root agents nobody meant to have.

**The thread says what changed.** Seating posts one message into the thread,
from the person who did it, that names the new job in a sentence, links the
role page, and says what did not change (its memory, its handle, its chat).
The agent's next turn is the chief of staff briefing, so the first thing the
person reads after the change is the agent restating its job in its own words.

**The thread looks like the role.** Once seated, the conversation's title is
the role's display name, the header carries its avatar and `@handle` with a
link to the scope page, and the inbox card says "Chief of Staff" rather than
"Anchor". `/anchor` redirects to the scope page, and the first redirect shows
one line saying where it went and why.

**Unseating is one act.** Retiring the chief of staff asks whether the
standing session should keep running as a plain agent (default) or be
retired with the seat. Keeping it restores its old title and clears the role
pointers, so the person is never left without the assistant they had.

The word anchor survives only as an alias in the CLI and in chat; every
surface reads Chief of Staff.

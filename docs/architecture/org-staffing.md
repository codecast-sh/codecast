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
  items_per_day: 30,       // distinct work items that reached the role's frames (its wake outbox), per day over 7 days; the scope's churn is flow.items_changed_7d, not load
  decisions_per_day: 4,    // decisions routed to the role, per day over 7 days: an immediate wake each
  live_hands: 6,           // read against the role's OWN hands cap; this default when it has none
  open_stalls: 3,          // review stalls + hands that reported blocked or needs context this week
  cap_hit_days: 1,         // days in the last 7 at the wake or token cap; more than one is a pattern
  bypass_done_7d: 10,      // tasks closed in scope in a week with no hand under the seat and no decision routed to it: the `bypassed` flag
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
revised (`cast org health`, the row's own `counted` note: 1 project and 29
plans in scope, every open task plus the week's closes). The seat the ledger
model told to split twice over (@product; ledger 93 open and 50 in flight by
the scope rule, where the older capped read had shown 63 and 24) had 0 hands,
0 decisions routed to it, 0 stalls and 0 cap hits while its scope closed 121
tasks in the week. Under the load model it is not overloaded. It is
`bypassed`: work in its scope that never reaches it, which is what a person
reading the evidence concluded, and the case a founder most needs named.

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
Flag = { code: "overloaded" | "bypassed" | "wide_ledger" | "wide_span" | "idle" | "slow_to_recommend" | "review_stall" | "cap_hit" | "unowned" | "no_charter" | "chatter" | "unfiled_plan" | "stale_plan" | "stale_task" | "stale_project" | "program_ended", severity: "info" | "warn" | "blocker", detail }
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

Supersession. A newer review replaces an older one in the open, never in
silence. `create` takes `supersedes: "op-N"` (`cast org propose --supersedes
op-N`). The older proposal must be open, in the same workspace, and the
author's own: the same session, the same role, a role over the session that
spoke for it, or the same person. Any other author is refused. The new row
stores `supersedes`, the older row gets `superseded_by`, and `list` and `get`
name both (id, short id, status, created_at). Both proposals stay open: a
session may not withdraw what it did not post, so the person does it. The pane
leads the older proposal with "Replaced by op-6, posted 2 hours ago" and a
Withdraw button (an optimistic store action with an org intent, dispatched to
`orgProposals.withdraw`); the newer one says "Replaces op-4" under its title.

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
- When no chief of staff exists and the company has two or more roles or three or more projects, counted after the proposal's own changes, offer an adopt change: this session becomes the chief of staff.

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
{ kind: "plan_status", plan: ref, status: "done" | "abandoned" | "active", reason, title? }
{ kind: "task_status", task: ref, status: "done" | "dropped" | "open" | "backlog", reason, title? }
{ kind: "project_status", project: ref, status: "paused" | "done" | "active", reason, title? }
```

`title` is the record's own title, carried on the change so its row reads
"Mark done: <title>" with the id as a pill wherever the proposal is read: a
reader's store may not hold that team's records. The analyzer copies it from
its inputs; `orgProposals.post` and a revise's add fill it from the record
when a spec left it out and the record is in the proposal's workspace
(`withRecordTitle`). `recordChangeParts` in the contract is the one reading of
the three fields; `changeLine`, the row, the log and the tooltip all use it.

Accepting a plan_status of done or abandoned closes the plan's still open
tasks in the same apply, through the one task path (`setTaskStatus`: the
team's status vocabulary, bound sessions
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
icons (24 painted storybook portraits, one style, 256 px WebP) lives in
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

## S17. A proposal a person can read cold

The reader has never heard of a role, a scope, a charter or a budget in
wakes. Nothing in the product may assume otherwise, and the first thing they
meet is usually a proposal, not the documentation.

**The pane leads with what this is.** Above the ask, two sentences that
survive a cold read: what codecast is proposing (people and standing agents
with a named area of work, so the agents know what to look after) and what
accepting costs (nothing moves until you accept a change; each one is
reversible except where it says otherwise). It carries one "how this works"
link to a short page, and a dismiss that never returns. A person who has
accepted a proposal before does not see it again.

**The ask is written for that reader.** The analyzer writes the ask as the
first paragraph of a letter to a founder who has not seen the feature: what
it looked at, what it wants, and what changes for them. A term the product
invented is explained the first time it is used or not used at all; a number
carries what it means, not only its value. Jargon a reader cannot decode
("16 plan closes that drop their own 74 leftovers") is a defect in the
prompt, not a style preference.

**Detail is behind the summary, never in front of it.** The pane shows the
plain ask, then the groups with counts, then the changes. The evidence, the
budget arithmetic and the findings sit behind one control each. A first
screen that scrolls is a first screen that fails.

**Every term has one place that defines it.** A glossary of the product's
eight words, reachable from the pane, the chart and the skill, each defined
in one sentence with an example from the reader's own workspace.

## S18. The conversation is part of the proposal

A structured list of changes cannot answer "why is growth in there" or take
"growth is dead, drop it". The pane therefore carries the conversation with
the agent that wrote the proposal, rendered inline beside the changes, not
as a composer bolted to the bottom.

**One thread per proposal.** The proposal's author (the chief of staff, or
the session that ran the review) holds a thread bound to `op-N`. The pane
renders it with the existing conversation view, so a person reads and writes
there exactly as they do in a session, and the thread survives a reload.

**The agent can change its own proposal.** `orgProposals.revise` lets the
author remove, amend or add a change while the proposal is open and the
change is still undecided. That is authoring, not deciding: accepting stays
the person's, and a revise never touches a change they already decided. The
pane shows what the revise changed, inline, the way an accept shows.

**So the loop closes in one place.** The person says what is wrong in plain
words, the agent answers and revises, the list updates under them, and they
accept what is left. Nothing about that loop asks them to leave the page, to
learn a command, or to know a word they have not been taught.

**The server half.** `org_proposals.thread_conversation_id` is set at create
to the posting session (a role's is its standing session); a person's
proposal has none, and `get` and `list` hand back `thread: { conversation_id,
short_id, title } | null` (derived from `author` for rows from before the
field), so the pane renders the conversation or says there is no agent to
talk to. `orgProposals.say({ proposal, change?, body })` puts a person's
words into that thread as an ordinary turn on the pending message rail,
wrapped the way a chat mention is: `<proposal-message proposal="op-N"
change="3" from="Name">`, the shared "About op-N change 3 (...)" header, the
words, and a tail naming `cast org revise`. `orgProposals.revise({ proposal,
ops })` takes `{ op: "remove" | "amend", seq, edits?, rationale?, note? }` and
`{ op: "add", change, note? }`: the caller must be the author (the session
that posted it, or the standing session of the role that did; a person with
no session for their own), the proposal open, and every named change still
`proposed`, else the refusal names the change; an amend runs the same patch
and validator as accept with edits, an add the same checks as create, and
one bad op writes nothing. A removed change keeps its row as `status:
"removed"` (out of every count, never decidable); an amended one keeps its
id, the new change replaces the old and `revision.before` keeps it; an added
one is a new row with the next seq. Every touched row carries `revision: {
kind, note, at, before? }` and the proposal appends to `revisions: [{ op,
seq, at, by, line, was?, note? }]`, the journal the pane and `cast org apply`
list. A revise never resolves the proposal, even when it removes the last
undecided change; the queue card is rewritten to the changes that remain.
The CLI verb is `cast org revise op-N --remove <seq> | --amend <seq> --edits
<json> --rationale <text> | --add <file> [--note <text>]`, session only.

**A verdict is read against what the page showed.** A revise moves what a
position and an id name: emptying an earlier ask moves every later ask up a
place, and an amend keeps a row's id while replacing what it says. So
`decide`, `decideAsk` and `acceptAll` take `seen: { revised_at, seqs? }`,
what the page had painted when the verdict was pressed: the latest
`revision.at` among its rows (`latestOrgRevisionAt`) and, for an ask, the
seqs its card held. The server compares both with the rows it holds
(`orgVerdictSeenFault`, shared, so the two sides cannot disagree) and refuses
the whole call when either differs, in one line ("op-N was revised after this
page read it; a verdict never lands on a change the person has not seen");
a caller that sends nothing is taken only on a proposal nobody revised. The
revise clock rises strictly, so two revises in one millisecond never share a
stamp. The page sends `seen` from the rows it rendered, flips exactly the rows
the card held, and on that refusal puts them back through the intent journal
and shows the revised list with the "since you last looked" marks (the
watermark reads server stamps on both sides, never the client's clock, so
the revise that refused the verdict is always among them), with one toast in
the server's words. Nothing is applied.

## S19. A proposal is a conversation with three asks, not a letter with 157 rows

Written 2026-09-17 after the founder read the pane with S17 and S18 in and
said it was still overwhelming, and asked for the conversation to lead. He is
right, and the reason is structural, not a matter of trimming.

**What is overwhelming.** The pane asks a person to decide 157 rows. The
proposal itself asks three things, and the letter says so in its first
paragraph: one, close the paperwork reality has passed; two, add one agent
for Agent Quality; three, retire the Test lead. Everything else on the screen
(the op-N pill, the provenance line, the progress strip, the link row, the
group headers, the sticky sections, the per row icon buttons, the tenure
chips, the evidence lines, the nested tasks, the accept all box) is machinery
for deciding 157 things one at a time. A person does not want to decide 157
things. They want to answer three questions and have the machine do the 157.

**The shape.** The proposal page is a conversation on the left and the asks
on the right. The conversation leads: it is wider, it is where the eye lands,
and its first message is the proposal in the author's own voice. The right
column holds the asks, one card each, and nothing else.

**The conversation.** One thread per proposal. Its first message is the
letter, rendered as the author's own bubble: a line of introduction the first
time a person meets the feature (who the author is, what it does, that the
person decides and nothing applies without them), then one short paragraph
per ask ending in what accepting changes for the reader. The budget, the
findings, the evidence and the rest of the letter are not sections above the
list; they are things the author can be asked about, and things the author
says when they matter. The person replies in plain words. A reply about one
ask carries that ask; the author answers, revises, and the card updates under
the reader. The thread shows the author's prose and the person's words; the
author's working turns (tool calls, files read, commands run) fold away, so
the thread reads as a conversation and not a transcript.

**The asks.** An ask is a group of changes with a title a person can read
cold, one sentence of why, one line of what accepting changes, and three
controls: Accept, Skip, Ask about this. Accepting an ask applies every change
in it through the one apply core, in `ORG_CHANGE_APPLY_RANK` order, the way
accept all does today for a kind. Skipping skips them all. The changes are
inside the card, folded, with a count on the fold ("105 records"); a person
who opens the fold gets today's rows and controls, one at a time, and a
single skipped row inside an accepted ask is the exception the fold is for.
The header above the asks is one line: the title and "0 of 3 decided". No
pill, no picker, no provenance line, no progress strip: the bubble on the
left already says who wrote it and when, and the cards say what is decided.
One line under the cards says the cost: "After: about a quarter less", with
the arithmetic one tap away, not three scenarios in a paragraph.

**Who writes the asks.** The analyzer does, at propose time: `asks: [{ title,
why, effect, seqs }]` on the spec, every change in exactly one ask, in the
words the letter already uses. `cast org propose` validates that partition
and refuses a spec that leaves a change out or names one twice. A proposal
from before this section, or one a person posted without asks, derives them
from the groups the pane already computes (the records group is one ask; each
role, retire, move and scope change is its own), so nothing old stops
rendering.

**The phone.** The conversation is the page. A bar at its foot says "3 to
decide" and opens the asks as a sheet. A card's Ask about this closes the
sheet with that ask attached to the composer.

**What goes.** The intro banner, the glossary link row, the summary controls,
the progress strip, the sticky group headers, the section label, the accept
all box and the op-N picker leave the first screen. The glossary stays as a
dialog reachable from the org header for a person who wants the words; the
proposal itself no longer needs it, because the author explains itself.

**The test.** A person who has never seen the feature opens a proposal and,
without scrolling, can say what is being asked of them, what it will change,
and what to press. If any word on the first screen needs the glossary, the
screen failed.

## S20. The first visit, and the introduction

Written 2026-09-18. The founder asked for a beautiful, elegant first visit to
the org page that describes the whole system succinctly, and for one global
introduction that pops up anywhere in the app and introduces this work. S14's
guide (three spotlight steps over the real canvas) stays as the way back from
"How this page works"; the first visit is its own moment.

**What a person needs to know, in five sentences.** Your company has roles:
agents that each keep watching one area of work, with a face, a boss,
sessions that report to them and tasks they own. A chief of staff reads your
workspace, commits, sessions, plans and tasks, and proposes the roles it
needs; you decide, and nothing changes until you accept. A role triages its
own sessions and puts in front of you only what needs you, with one line
saying why. You can talk to any role from its page, and hover any role
anywhere to see what it looks after. All of this also works from any session
by asking for /cast-org.

**The first visit.** The first time a person opens the org page with roles
in it, or with none, the page opens on the introduction rather than the
canvas: one screen, no scrolling on a laptop, that a person reads in thirty
seconds. It is built from the painted faces, because the faces are the
feature's own character: five or six of them arranged as a small company at
the top, each one standing for one of the five sentences as it reveals, one
after the other, in one orchestrated entrance (the faces first, then the
lines, then the two actions). The type is the org page's serif for the one
title and the app's mono for the lines. The palette is the app's own
(`--sol-*`), warm and cream in light, the same faces in dark. No dark
charcoal with an amber accent, no uppercase letterspaced kicker, no italic
clause in an accent colour, no rule above the title. Two actions and only
two: the one that starts (Ask the chief of staff to look at my workspace, or
Open the chart when roles already exist) and Later. Later never returns on
its own; "How this page works" in the header reopens it. Seen is one pref,
`org_intro_seen`, written by either action or by the first accept of a
proposal (S17), on the store and synced, so it is seen once per person and
not once per browser.

**The introduction anywhere.** Once per person, on the next visit to any
page after the feature is available in their workspace, a card rises from the
bottom right corner: one face, one title ("Meet your organization"), two
lines (a chief of staff reads your workspace and proposes the roles it needs;
each role watches one area and brings you only what needs you), and two
actions: See it, which opens the org page on the first visit above, and Not
now. It rises once the page has settled, never over a composer with text in
it, never during a call, never on a phone narrower than a tablet (there the
org page's own first visit does the introducing). Dismissing either way writes
`org_upsell_seen`; seeing the org page by any route writes it too, so a person
who found the feature on their own is never sold it afterwards. It reuses the
banner and toast primitives the app already has for a rising card
(NewSnippetsBanner, the call toasts) rather than adding a third.

As shipped (2026-09-18): the first visit is `OrgIntro` (components/org),
mounted by the org page over the whole page once the tree and the prefs have
landed and `org_intro_seen` is unset; the five faces are the owl above a rail
of fox, bear, hare and crane, the entrance is CSS keyframes keyed by one
delay per piece (globals.css, "org-intro"), and the company scales with the
room the screen has. "How this page works" now reopens this screen, so S14's
guide keeps only its own auto open, and it waits for a later visit to an
empty workspace instead of following the intro. The card is `OrgIntroCard`
on the app's toast, gated by `orgIntroCardMayRise` and mounted once in the
dashboard layout as `OrgIntroAnywhere`; `org_upsell_seen` is the pref, and
both writes go through `markOrgIntroSeen` / `markOrgUpsellSeen`. With a
composer on screen the card lifts its toast wrapper so its foot clears the
composer's form (`composerLift`): a person can send under it without
dismissing it. One name for one thing: the screen, the card and the lines
say "organization", never "company".

**The test.** A person who has never heard of the feature reads the first
visit and can say, in their own words, what a role is, who proposes them, who
decides, and what reaches their inbox. If they cannot, the lines failed. If
they took longer than thirty seconds, the screen failed. If the screen reads
as any AI product's onboarding, the design failed.

## S21. The record, and the way back

Written 2026-09-20. The founder asked for an audit log of org changes a
person can read, with undo and redo, "so that user can have more confidence
in making changes", and for our own testing. A person accepts a proposal more
easily when they know they can take it back, and we can apply a real proposal
to a real workspace, look at the result, and return it to where it was.

What exists is not this: `org_role_history` records a role's field changes as
strings, no page shows it, it does not know what else a change did (the
sessions a takeover moved, the tasks a retire handed up), and it covers roles
only, not records, leads, initiatives or sessions.

**One log.** `org_changes`, append only, one row per thing that changed the
organization, written inside the transaction that changed it, at the few
cores every door already goes through (the proposal apply core, 
`performUpdateRole`, `performRetireRole`, the reparent core and its batch
form, `performSetProjectLead`, `performCoverProjects`, the seat, escalation
is not an org change and is not logged here). A row carries: the workspace
access key and routing team; `seq` rising per workspace; `batch` (what the
person did in one gesture: an accepted ask, an accept all, one Settings
save, one drag on the chart), so a gesture is one entry with its rows
inside; `door` (proposal, settings, chart, project page, initiative, cli);
`actor` (the person, and the proposal and ask when there is one); `kind` and
`subject` (the role, project, plan, task, session or initiative); `before`
and `after`, the fields that moved, typed, enough to write the inverse; and
`effects`, what the change did beyond its subject: the sessions a takeover
moved with where each was before, the tasks a retire handed up with who
held each, the scope a lead or an initiative owner gained, the routines a
seat started. A row never stores a sentence; the sentence is rendered from
the row by the same functions the proposal page uses (`changeLine`,
`takeoverPhrase`), so the log, the proposal and the undo preview say one
thing in one way.

**The page.** History is a tab of the org page's panel and a section of a
role's Scope view filtered to that role. Newest first, grouped by day, one
entry per gesture: who, when, through which door, one sentence, and the
count of rows inside behind a fold ("Accepted "Close the plans and tasks the
work has already passed": 100 records"). An entry that was undone stays in
place, struck, with who undid it and when. `cast org log [--role @h]
[--since 7d]` prints the same entries.

**Undo is a new change, never an erasure.** Undoing an entry applies the
inverse of each of its rows through the same cores, in the reverse of the
apply order, as a new batch whose rows point at the rows they undo
(`undoes`), and stamps the original `undone_by`. Redo is undo of the undo.
The log only ever grows, so it stays an audit trail.

**Before it happens, the person sees what it will do.** Undo opens a
preview built by a dry run of the inverse, the same pattern as the takeover
count: the sentence for each thing that will change back, and, stated
plainly, what will not:
- A row whose subject changed again since is left alone and named ("3 of
  100 records were changed after this and stay as they are"): undo never
  overwrites a later decision by a person or another change.
- A later entry that depends on this one is offered with it, never undone
  silently and never orphaned: undoing the hire of a role that later gained
  a project, took tasks and was made an initiative's owner lists those
  entries, and the person undoes them together or not at all. The
  dependency rule is the one the proposal page already has
  (`orgChangeDependencies`), read backwards.
- What cannot be taken back is said once, in the preview: a message a role
  already sent, a wake that already ran, work a session already did. The
  sessions are told again when they move back, the way they were told the
  first time.

**Each kind's inverse.** A hire retires the role and returns its sessions
and tasks to where the effects say they were; a role seated on an existing
session is unnamed and the session keeps running under its person. A retire
restores the role with its scope, trust, limits, routines and face, reseats
its session when it still exists, and takes back the tasks it handed up
that nobody has touched since. A scope, move, budget, trust or routine
change restores the fields in `before`. A lead restores the previous lead
and removes the scope it added. A record change restores the status it had,
and a plan reopened this way reopens the tasks it closed with it. A
takeover returns each session to the parent in `effects` unless it has
moved since. An initiative's owner change restores the owner and the scope.

**Who.** Undo and redo are a person's, in the browser, by someone who could
have made the original change (`refuseUnlessHuman`, admin where the change
needed one). A role or a session never undoes; `cast org undo` from a
session says so and gives the page.

**For us.** The analyzer's evaluation (docs/architecture/org-eval.md) applies
a proposal to a workspace, reads the result on the real pages, and undoes
the batch. The undo's own correctness is tested by the round trip: apply,
undo, and the workspace's org state compares equal to the snapshot taken
before, field by field, with the log two entries longer.

**The test.** A person accepts an ask they are unsure about, opens History,
reads in one sentence what happened and to how many things, presses Undo,
reads what will and will not change back, confirms, and the chart, the
inbox and the board are where they were. They then press Redo and it is
applied again.

## S22. One agent at the root

Written 2026-09-21. The founder: "anchor + chief of staff / org stuff being
separate does not make sense, these need to become a single cohesive thing,
having both separate is confusing." S12 decided this in words and the product
did not follow: the sidebar still lists Anchor under Agents, /anchor is its
own page with its own header, the chart draws an "Anchor · standing agent"
card beside a "Chief of Staff · role" card, the anchor chip and panel in the
app shell know nothing about roles, and a workspace without a chief of staff
has an anchor with no place on the chart at all. Two names, two pages, two
cards, one thing.

**There is one root agent per workspace, and it is a role.** The workspace's
standing agent is the root role of its org, named Chief of Staff by default
and renamable like any role, with a face, a charter, a brief, sessions that
report to it, tasks it owns, and the whole workspace as its scope. A
workspace that has an anchor and no root role has one from the moment this
lands: the migration names the anchor's session as the seat of a root role
(the same seating S16 uses, nothing restarts, the Slack binding and every
alias keep working), so no workspace has an unnamed root. A personal
workspace has one too: the person's own root role, which is the goal tracker
of R6 for one person.

**One page.** `/anchor` is the root role's page, the role page as the
session page (I3): conversation on the left, Scope on the right. The sidebar
entry under Agents is the root role by its name and face, not the word
Anchor, and it opens that page. The anchor chip in the app shell and the
anchor panel become the root role's chip and panel: same face, same name,
same conversation. `cast anchor say` and `@anchor` in chat stay as aliases
of the root role's handle and print nothing about anchors.

**One card.** The chart draws the root role once, at the top under the
person it reports to, with its seat inside it as any role (R1 fixed this for
other roles; the root is not an exception). No node of kind anchor remains
in the layout; the anchors table stays as the seat's storage and nothing
else reads it for display.

**One word.** Anchor leaves every surface a person reads: the org page, the
sidebar, the chip and panel, the first visit and the tour, the glossary, the
skill, the CLI's printed sentences, the mobile app, the notifications. Where
a sentence needs the thing, it says the role's name, or "the workspace's
agent" when no name fits. The tables, the functions and the memory notes
keep their names; the word is retired from the product, not from the code.

**The test.** A person opens the sidebar, the chart and the inbox and sees
the same agent in all three, with one name and one face, and opens the same
page from each. Nothing on any screen invites them to wonder which of two
agents they are talking to.

**As built (2026-09-21).** The seat is `orgRootSeat.seatRootRoles`, an
internal mutation that walks live anchors with no role pointer and calls
`performStaff` for each with `seat: "existing"`, so the session is adopted,
the note and the briefing land in it, and the weekly review is armed. The run
is all or nothing: a seating that fails throws out of the mutation, so no
workspace is left with a Chief of Staff row and no seat. A workspace whose
root role already stands in another session is reported as `two_roots` and
left for a person; one whose root a person retired while keeping the agent is
still seated, and the plan names it `retired_root` with the seat it replaces.
`orgRootSeat:rootSeatPlan` is the read only listing, and `anchor_ids` on the
run seats only the rows named (the rest are reported `held`), which is how
the founder seated the Codecast team's and their own personal agent on
2026-09-22 (or-23, or-22) and left two other people's for them to hire. There is no door that
provisions a bare anchor any more: `/cli/anchor/create`, `cast anchor create`
and the web onboarding all run `orgRoles.staff`, and each names the team
outright (`staffTeamFor` refuses a team scope with no team; the CLI resolves
a bare `--team` through the same write resolver every other verb uses). `listAnchors`
carries the seated role's `{name, handle, avatar, short_id}` so the shell
draws the role from the row alone: `useRootAgent` (hooks/useSyncAnchors)
answers "the active workspace's agent" for the sidebar's entry under Agents,
the header chip and the slide-over. `/anchor` renders `ScopePageInner` for the
root role in place (an `href` prop keeps the tab in that address), and the
Slack connection is a section on the root role's Settings tab. The layout has
no anchor node kind; `orgRows` on the phone follows. The guard is
`lib/__tests__/anchorWord.guard.test.ts`: it reads string literals and JSX
text under web, mobile, the CLI, the shared contracts and convex, and fails on
the word outside the verb sense and the `cast anchor` command name.

## S23. Less to reason about: no stages, no budgets, no rows under a role

A person who opens the inbox should meet their agents the way they meet a colleague: a name, a face, what it is doing, and what it needs from them. On 2026-09-22 the founder met instead a role card with three session rows folded under it, a session put in front of him with no reason he recognised, and a lead asking him to "raise its trust to direct" so that it could start a builder, with the token budget in the same breath. The machinery was working as specified. The specification asked the person to hold too much in their head. This section takes three ideas out of the person's view and out of the role's voice.

### S23.1 A role has one switch, not three stages

The trust stages (understand, decide, direct) collapse into one switch on the role's page: **Starts work on its own**. On, the role starts hands and answers decisions inside its scope. Off, it reads, answers questions, and recommends; what needs doing goes to the person as one recommendation, and the person starts it or flips the switch. The root role's switch is off and cannot be turned on: it proposes, a person applies (S12). Every other role's switch defaults to on when a person hires it, whether through an accepted proposal, the org skill or `cast role create`, because a person who hired a lead wants it to lead.

The words trust, stage, understand, decide and direct leave every person facing surface: the role page, the chart, the proposals, the history lines, the CLI's output and help. The stored field stays for one release under its name, mapped both ways (on is direct, off is understand; decide reads as on and is never written again), so nothing that reads it breaks while the surfaces move, and a source test pins the words gone the way S22's pins the old name.

A role never asks for the switch. Its standing text says that when it cannot start work on its own it says so in one line and recommends; it does not queue a decision about its own settings, and the frame does not name the switch's state. The org review may propose flipping a role's switch, once, as one plain sentence with the evidence beside it, in the same ask as the rest of what it proposes for that role.

### S23.2 Caps are a safety net the person does not see

Hands, wakes and tokens per day stay as the bound that keeps a runaway role from spending a week's budget in a night. They stop being something the person sets, reads about, or is asked about:

- The proposal never asks about limits. The analyzer's sizing rule and the "daily allowance" asks go; a proposal names roles, scopes, records and the switch, and nothing else about a role's operation. The eval rubric's sizing line goes with it.
- The role page shows no numbers by default. A disclosure under the role's settings, **Limits**, holds the three values with the defaults filled in, for the person who wants to look.
- A role that reaches a cap waits. It writes one line in its brief and its pinned state says it is waiting for tomorrow; the org health view carries that line; nothing reaches the person's inbox or their queue. The role's standing text drops "caps are real" and the frame drops the counters.

### S23.3 A role's sessions are the role's

A role's sessions are subagent rows under the role's card: the same small row a Task subagent gets, hidden and shown by the same subagent toggle, with no gesture of their own. The card also carries a count, **3 sessions**, that opens the role's page, where the sessions are the panel's business (F4). What reaches the person from under a role is the role's own line on its card (R1, revised), and nothing else. (Revised 2026-09-24: the first cut drew no rows at all, and the founder read the count alone as hiding the reports.)

### S23.4 The line a person reads names who did it

An escalation line always says who put the session in front of the person and why. A person's own gesture reads as their own; a role's reads as the role's, with its reason. The Calling lead's case read "Ashot Petrosian put this in their inbox" because the actor resolved to the host person when the caller's session was not named; the server resolves the caller from the session the command runs in, so a role's command is the role's whatever the CLI passed, and a line with no reason from a role is refused rather than filled in with a person's name.

### What this changes

Web: the role page's Settings tab (one switch, Limits disclosure), the chart's role card, the inbox card (count, no nested rows), the proposal thread and asks, history lines, the first visit copy. CLI: `cast role trust` becomes `cast role autonomy on|off` with the old verb as an alias for one release; `cast role caps` moves under `cast role limits`. Convex: the switch mapping, the actor resolution in `performEscalateSession`, the analyzer input and prompt (sizing gone), the standing text and the frame. Eval: the sizing rubric line removed; one round on Union to confirm no ask about limits appears and the cards still stand alone.

**As built (2026-09-23).** The switch is one shared mapping,
`@codecast/shared/contracts/roleAutonomy`: `autonomyOn(trust)` is true for
`direct` and `decide`, `trustForSwitch(on)` writes `direct` or `understand`,
and the words a person reads (`Starts work on its own`, "starts work on its
own", "turned on/off starting work on its own") live beside it. The stored
field keeps its name and its three values; nothing reads a stage word any
more. Convex reads the switch through `orgEvents.roleStartsOnItsOwn`, which
gates `spawn.gateRoleCaps`, the line sweep (`orgLine`) and
`sessionDecisions.answererFor`; each refusal says the role does not start
work on its own and names no verb, because a role never asks for its own
settings (S23.1). `orgRoles.setTrust` takes `{ on }` (and a stage word for
one release, mapped the same way; `decide` is never written again), refuses
`on` for the root, and writes the charter note in a person's words; the
routes `/cli/role/autonomy` and `/cli/role/limits` sit beside `/trust` and
`/caps`. `performCreateRole` writes the switch on for every handle but the
root's. The migration for roles that already exist is
`orgAutonomyDefault.turnOnExistingRoles`: a read only plan
(`autonomyDefaultPlan`) that names every role and why (turn_on, already_on,
root_off, retired), a `dry_run`, and an explicit `role_ids` list that holds
the rest; the founder decided every non root role turns on and the root
stays off, and the run is theirs to start. The standing text and the frame
carry no stage, cap, budget or token word: the frame names the role, its
parent, its scope and its authority outside codecast, and no counters; rule
4 of `ROLE_RULES` says a day's limit is a line in the brief and the pinned
state, then waited out. `performEscalateSession` (S23.4) reads a terminal
call that names no session as one the server cannot see the author of:
without a line it is refused, with one it is recorded as the role's, so a
person's name is never filled in for a role's escalation; the browser
gesture is unchanged. The analyzer (`orgInitRun.ts`, `orgInit.ts`) lost the
sizing sentences, the `budget` kind, the cost rule and every allowance word;
it spells the switch `autonomy: { handle, on }`, which
`parseOrgProposalSpec` maps onto the stored kind, and the capacity model
ends by saying a limit is never proposed, stated or asked about. Round 12 of
the Union eval (three samples on served/base6, prompt 279a117670ce, graded
with the sizing line replaced by "No limits") closed no alive record, asked
about no limit in any sample, and kept the same three asks across all three;
records recall was 12, 10 and 6 of 41, inside the variance rounds 9 to 11
showed. On the web the Settings tab is one switch and a closed `Limits`
disclosure with the defaults filled in (`ScopeSettings.mount.test.tsx`); the
hire dialog names neither; `orgProposal.changeSentence`, the history line
(`orgLogLine`), the chips and the kind labels say "starts work on its own";
the proposal pane's cost line and sheet are gone; the overview tile with the
day's counters is gone; the charter's project line reads "Daily limit". The
inbox nests a role's hands under its standing session in `subsByParent`
like any subagent (the toggle hides them; no "Put in my inbox" on the row)
and hands the standing session a count (`roleSessionsByLead`) that the web
card and the phone card draw as "N sessions" opening `/org/or-N`
(`inboxRoleTriage.mount.test.tsx`);
the role's own lines (R1, revised) stay. `lib/__tests__/roleWords.guard.test.ts`
pins trust, the stage words in their stage sense, cap, budget and allowance
out of the web's readable strings, the way S22's guard pins anchor. The CLI
has `cast role autonomy <handle> on|off` (`trust` hidden as an alias for one
release) and `cast role limits` (`caps` as its alias); `cast role ls` and
`show` say whether a role starts work on its own and read today's use
against its limits. The phone's org page and role rows carried none of the
words; its inbox card gained the same count.

# Staffing: the company model, the head of people, and proposals on the chart

Builds on org-roles.md, org-roles-standing.md, org-init.md, scopes-and-feed.md.
The org already runs. This layer designs it and keeps it flowing: an agent reads
how work moves, proposes the organization as ghost nodes on the org page, and a
person accepts, edits or skips each change. The same agent can hold a standing
role, the Head of People, with a routine that reviews the company on a cadence.

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
| Head of People | The role that reviews the company and proposes staffing | org_roles (handle head-of-people) |

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
  items_per_day: 30,       // turns of the standing session (what was said to it), per day over 7 days; the scope's churn is flow.items_changed_7d, not load
  decisions_per_day: 4,    // decisions routed to the role, per day over 7 days: one line into its session each
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
from the same scan org.tree uses plus: the standing session's user turns and org_roles.counters
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
            flow: { decisions_7d, items_changed_7d, median_recommend_min, escalations_7d, done_7d, handoffs_7d: { done, blocked, needs_context }, review_stalls, sends_7d: { to: [{ role_id, n }], from: [...] } },
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
agent (the head of people, an analyzer run) or a person, decided change by
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
it addresses ("Head of People proposes N changes", link `/org?proposal=op-N`,
default "review on the org page"); answering it does nothing but clear the card.
The existing decision stack path (`cast org init`, templates) stays; `cast org
init` and `cast org update` now write a proposal and print its short id, and
`cast org apply op-N` prints the proposal and the page link, since a shell
cannot decide. The stack
apply (`ds-N`) keeps working for stacks already created.

## S5. The org page: ghosts and the staffing pane

(Retired 2026-10-07 by S41: the staffing pane, its asks column and the ghost answer strips are gone; the ghosts themselves are the map's proposal marks, S40. Kept as history.)

Ghosts. Open proposal changes render on the chart merged into the layout:

- role: a ghost node under its proposed parent (a thin violet outline over a soft violet tint, 55% opacity, the role's handle, scope chips, the word "proposed").
- move: a violet edge to the new parent; the old edge at 30% opacity.
- retire: the node with a hatched overlay and the word "retire".
- scope, budget, trust: a violet chip on the node ("+ project X", "tokens 400k to 800k", "trust to decide").
- routine: a violet clock chip on the node.
- project_meta: a violet chip on the scope panel's project row.

A proposed thing wears one quiet mark on the chart: the tint and outline
(`changeFrameStyle`, `orgMeta.ts`) with its icon in violet. Its tag is a plain
word, its chips are solid, and no card, tag, chip or edge on the chart is
dashed. A chart full of proposals must still read as a chart.
- adopt: a ghost node marked "this session" when the viewer is looking from the session that offered.

Every ghost carries an action row: Approve, Reject, Reply, Edit. The first
three are the ledger's own answer controls (S39) over the card that holds the
change: nothing fires on a press, the answer waits in the batch of the
conversation beside the pane (its composer tray shows it and its send carries
it) or, with no conversation beside it, in the proposal's own key with a reply
box at the pane's foot. Under the strip the ghost reads its answered state in
words ("Approved, on your next message", "Rejected: too soon"); Reply opens
the ledger's field there. Edit, accept with edits, is the one direct verdict:
it opens the hire dialog prefilled (role) or an inline form (the others) and
its accept is optimistic: the change flips to accepted in the store and the
tree draft gets the stub (a created role stub keyed by the change id,
superseded when org.tree echoes; a move re-parents the row; a retire hides it)
with a dispatch side effect to `orgProposals.decide`.

The staffing pane (the right sheet, a "Staffing" mode of the existing panel):
header (proposal title, author, age, N of M decided), the company's flags
(bottlenecks and span of control, each linking to its node), the change list
(status, one line, accept/edit/skip, click to focus the ghost), the rationale
with evidence links for the selected change, "Approve the rest", and a
composer that talks to the head of people's standing session (a send through
the existing pending message rail; the thread renders below the composer
through the embedded conversation view). With no open proposal the pane shows
the health summary and the composer. With no head of people it shows two
buttons: "Hire a Head of People" and "Propose an org now".

Phone: the pane is the bottom sheet; ghosts render the same.

## S6. The Head of People

`orgRoles.staff({ team_id?, reports_to?: user, adopt_conversation_id? })`:
creates the role (name "Head of People", handle `head-of-people`, scope the
whole company, reports to the hiring person, trust understand, charter from
the template below), provisions its standing session (or adopts the given
conversation: sets standing_role_id and persistent on the existing row and
creates the anchors row pointing at it), arms one routine on the standing
session ("Company review", every 7 days, prompt: run `cast org review`), and
runs the first review at once. Idempotent per company. `cast org staff
[--adopt] [--every 7d]` is the CLI; "Hire a Head of People" is the button.

The charter (principle level, in orgRoles.ts next to the role charter
template): you are the head of people of this company; the executives decide,
you propose; read how work flows before you touch the chart; the capacity
model and the stability rules; propose the smallest change that removes a
bottleneck; every change carries evidence a person can click; never apply;
write for a founder who reads it on a phone; escalate anything about budget
or people to the person you report to.

Trust never rises above understand for the head of people: it applies nothing.

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
takes `standing_session: "keep" | "retire"` (default keep for the Head of People,
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
- When no head of people exists and the company has two or more roles or three or more projects, counted after the proposal's own changes, offer an adopt change: this session becomes the head of people.

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

## S12. The Head of People is the workspace's standing agent

The word anchor leaves the product. The workspace's root standing agent is
the Head of People: `cast org staff` adopts the existing anchor conversation
as the Head of People's standing session when one exists, so nothing restarts and
the Slack binding, `@anchor` in chat and `cast anchor say` keep working as
aliases of the Head of People (`@head-of-people`). The org page draws the root seat as
"Head of People"; `/anchor` redirects to its scope page; the anchors table
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
buttons are the real "Hire a Head of People" and "Propose an org now". The
guide can be dismissed and never returns; a "How this page works" link in the
toolbar reopens it. The empty workspace canvas is designed, not blank: the
person's own node, the two buttons, one paragraph.

## S15. Where a proposal came from

Every proposal names its author as a pill: a session (title, short id, opens
the conversation) or a role (name, avatar, opens its scope page). The pane
header, the queue card and the analyzer's summary page all carry it.

## S16. Seating the workspace's standing agent is an explained moment

One workspace has one root standing agent. It used to be called the anchor;
its job is now named Head of People. Hiring must never feel like a takeover of
a thread the person already talks to, so the transition is explicit, announced
and reversible.

**The hire form names what will happen.** When a workspace already has a
standing agent, the form opens on that fact: "This workspace already has a
standing agent, <name> (thread jx7abcd, N messages). Seating it as Head of
People keeps its memory, its chat handle and its Slack binding, and adds the
weekly company review to its job." Two choices, the first selected:

- **Seat the existing agent.** No restart, no second session.
- **Start a fresh session.** The old agent is retired in the same act, with
  its thread kept and linked from the new role's page, so a workspace never
  ends with two root agents nobody meant to have.

**The thread says what changed.** Seating posts one message into the thread,
from the person who did it, that names the new job in a sentence, links the
role page, and says what did not change (its memory, its handle, its chat).
The agent's next turn is the head of people briefing, so the first thing the
person reads after the change is the agent restating its job in its own words.

**The thread looks like the role.** Once seated, the conversation's title is
the role's display name, the header carries its avatar and `@handle` with a
link to the scope page, and the inbox card says "Head of People" rather than
"Anchor". `/anchor` redirects to the scope page, and the first redirect shows
one line saying where it went and why.

**Unseating is one act.** Retiring the head of people asks whether the
standing session should keep running as a plain agent (default) or be
retired with the seat. Keeping it restores its old title and clears the role
pointers, so the person is never left without the assistant they had.

The word anchor survives only as an alias in the CLI and in chat; every
surface reads Head of People.

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

**One thread per proposal.** The proposal's author (the head of people, or
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

(The asks column beside the thread and the phone's asks sheet were retired 2026-10-07 by S41; the asks live on as the record groups and subject cards inside the conversation's card.)

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
sessions that report to them and tasks they own. A head of people reads your
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
two: the one that starts (Ask the head of people to look at my workspace, or
Open the chart when roles already exist) and Later. Later never returns on
its own; "How this page works" in the header reopens it. Seen is one pref,
`org_intro_seen`, written by either action or by the first accept of a
proposal (S17), on the store and synced, so it is seen once per person and
not once per browser.

**The introduction anywhere.** Once per person, on the next visit to any
page after the feature is available in their workspace, a card rises from the
bottom right corner: one face, one title ("Meet your organization"), two
lines (a head of people reads your workspace and proposes the roles it needs;
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

Written 2026-09-21. The founder: "anchor + head of people / org stuff being
separate does not make sense, these need to become a single cohesive thing,
having both separate is confusing." S12 decided this in words and the product
did not follow: the sidebar still lists Anchor under Agents, /anchor is its
own page with its own header, the chart draws an "Anchor · standing agent"
card beside a "Head of People · role" card, the anchor chip and panel in the
app shell know nothing about roles, and a workspace without a head of people
has an anchor with no place on the chart at all. Two names, two pages, two
cards, one thing.

**There is one root agent per workspace, and it is a role.** The workspace's
standing agent is the root role of its org, named Head of People by default
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
workspace is left with a Head of People row and no seat. A workspace whose
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

A role's sessions are subagent rows under the role's card: the same small row a Task subagent gets, hidden and shown by the same subagent toggle, with no gesture of their own. The card also carries a count, **3 sessions**, that opens the role's page, where the sessions are the panel's business (F4). What reaches the person from under a role is what the role raises in its own thread (S28), and nothing else. (Revised 2026-09-24: the first cut drew no rows at all, and the founder read the count alone as hiding the reports.)

### S23.4 The line a person reads names who did it

(Written for `cast escalate`, which S28 removed. The principle stands for every line a role writes into a person's view: it says who asks and why, in the role's own name, never with a person's name filled in.)

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

## S24. The review is a conversation

The Head of People reviews the company the way a good head of people talks to a founder. It reads everything first: activity, records, sessions, calls, chat and health. Then it talks. Its messages are short and in plain words, and each one moves the conversation forward. It asks when it cannot settle something from the records. It takes the answer and moves on. The person can steer it at any point, and it follows.

The heart of the conversation is the reporting structure: who reports to whom, what each role looks after, and where the person's sessions go. The Head of People says that plainly and early. Everything else serves it, such as closing records that are already done, or proposing a goal.

Knowledge stays behind the words. The Head of People holds the evidence and gives it when asked. A message never cites IDs, never talks about itself, and never names the thread it is written in.

A picture renders inline where a picture beats prose. When the Head of People has something the person can agree to, it posts a small proposal and puts its short ID on its own line. The message then draws a live card: each change as a plain sentence, the fields it moves with what was there before, the reason under it, and Approve, Reject and Reply on each (S39). When the talk turns to one change, the proposal's short ID, `#` and the change's number on its own line draws that change's card alone. The chart on the org page shows the same change as ghosts. The person agrees to many small things as the conversation goes, never to one large document. A change the person has not approved changes nothing.

The card is answered, never clicked through. A person approves a change, rejects it, or writes back on it in their own words, and the answers collect in the composer's pending tray, the one the quote UI uses, until they send. One send applies the approvals and delivers one message to the Head of People that names each change with the person's words beside it. Rejections and notes are the person's edit: the Head of People revises the proposal from them and says what changed in a sentence. Approvals are applied by the send, so the agent reads them as done, never as a request.

The same conversation runs on the org page, beside the chart, and from `/cast-org` in any session.

**The thread offers the review itself (2026-10-02).** Nobody types a slash command to set the org up or bring it up to date: the Head of People's own thread (its role page, the inbox pane that renders it, the header panel) carries one calm row above the composer, `RoleOffer` (components/org/scope), read as the role's offer rather than a toolbar. "Set up the org" while no proposal has ever been made and "Review the org now" after, both the Company review trigger run now (`triggerAction(id, "runNow")`, the same run `cast trigger run` and the Triggers tab start, so it stays one trigger the person controls); "Plan the goal tree", the same run with a focus (`agent_tasks.requested_run_focus`, a key of `ORG_REVIEW_FOCUSES` in `shared/contracts/orgReview.ts`, carried into the run's frame as a `focus` attribute and the focus's words ahead of the routine's prompt, cleared when the run completes); and "Open the proposal" while one waits, with what is left to decide. The row derives one state (`roleOfferModel.ts`) from the seat's Company review trigger, the seat's work state and the workspace's proposals: a run asked for and not yet delivered reads as starting, a delivered run the seat is still working on reads as reviewing, and in both nothing on the row can start a second run. The proposal's card lands in the thread where the role posts its short id; the row never draws it twice. A pause the person set holds: the row offers to resume, never to run around it. A reader who may not talk to the seat gets the state and the proposal, no run buttons. `window.__roleOffer.fake(...)` moves the row on a real page without dispatching, for looking at its states.

## S25. A role wakes through triggers and messages, nothing else

A role is a session. It wakes the way any session wakes, and nothing else wakes it.

- Its triggers, created with the role and controlled by the person like any other trigger: on the Triggers page and on the role's Triggers tab, with the next run, where they edit, pause or cancel them. A role has two: its check ("Check <area>", daily by default; the Head of People's is the weekly Company review), and "A session under you needs input", which fires when a session that reports to the role is waiting (S28). A trigger the person cancelled stays cancelled. Pausing a role pauses the triggers it paused and resuming resumes only those; one the person paused by hand stays paused.
- An ordinary message: a person writing to it, a chat mention, a question routed to it, a role that reports to it. It arrives as a plain message.

A change in the role's area wakes nothing. When a trigger fires, its run arrives in the role's thread in one frame, built in one place for every path that delivers it (`triggerFrameFor` in `convex/agentTasks.ts`; the daemon asks for the same frame through `agentTasks.injectFrame`): the trigger's prompt, the role's card, and, for a needs-input run, the waiting session.

- The role card reminds the agent who it is, read fresh at firing, so a long running role never works from a stale idea of itself: its name and handle, who it reports to, what it looks after (or that it looks after no area of its own), its charter, and the goals written on the projects in its area. Its brief stays its memory; the card is its identity.
- In the thread the run is one line at rest: the trigger's pill, the waiting session and how long it waited, when. It opens inline to the card, the waiting session's state and the prompt, and the pill opens the trigger, where the person changes it. In a folded thread the line stays, so a role's reply never reads as unprompted.

**The check reads the initiatives it owns (2026-10-02).** `cast brief` lists the initiatives a role serves (`org.brief` facts `initiatives`, from `lib/roleInitiatives.roleServedInitiatives`: the ones it owns first, then the ones its projects carry), each with its health as last said and when (`health`, `health_at`), its chain and its numbers against their targets. The check prompt (`ROLE_CHECK_PROMPT`) tells the role to post the read with `cast initiative update` when what it reads differs from that health or the health is older than a week, so one "at risk" never stands for eleven days unread. The brief also carries the role's own standing session as the org card reads it (`facts.standing`: work state, pinned status and line), printed on the `standing session:` line of `cast brief` and `cast role show`.

## S26. Work belongs to the most specific role that covers it

The Head of People owns what no narrower role has claimed. When a lead takes an area, that area leaves the Head of People; when the lead goes, the area falls back. Two roles never answer for the same work.

Scope is opt in. A role that names no projects and no plans owns no work: it is a standing role that runs its routine and answers what it is asked (a release lead that walks the merge train, a person's permanent assistant). Only the Head of People, while it names no scope, stands for the whole workspace.

One entity for everything is a Head of People and nothing else: it covers the workspace and owns all of it. Leads are added one area at a time, each taking its area from the Head of People, and the Head of People keeps the rest. Moving between the two is adding or removing a lead; nothing is reconfigured.

Reporting and ownership are separate. Leads report to the person by default; the Head of People reports to them too and keeps the structure true. Its opening message says so: it reviews the org weekly, proposes and applies nothing, looks after what no lead owns, and brings decisions with a recommendation. The review runs in its own thread: it starts no session for it, so a Head of People that does not start work on its own still reviews. The person's right hand is the Chief of Staff, a separate role (S30).

The rule has one home, `ownerOf` in `packages/shared/contracts/orgLead.ts`: a role naming the work's plan beats one naming its project, which beats the Head of People; on a named area the role closest to the work wins. `projectLeadOf`, the takeover and its preview (`convex/lib/orgOwnership.ts sessionsOwnedBy`), the line's pick, a retired role's tasks and sessions, and org health's remainder all read it. Reading is unchanged: the Head of People's scope feed still shows everything.

## S27. A reset clears the org

Resetting a workspace's org retires every role with its standing session and triggers, withdraws open proposals, and archives every proposal so no list returns it. A review after a reset starts from the work alone: projects, sessions, commits, chat and calls. Nothing an earlier org proposed or decided reaches it.

## S28. A request goes up the reporting line

Written 2026-09-29, replacing escalation (`cast escalate`, org-roles-run-work.md R1 and R1 revised). The founder's reading of the escalation card was that a role's line, crammed into the inbox card with its own buttons and a hand-back gesture, was a surface nobody wanted. The fix is not a better surface. The org already has a way for a request to travel: messages, up the line, with the person at the top of the tree.

**The route.** A session under a role that is waiting on anyone, for any reason (an open prompt, a stopped process, a declared blocked state, a question asked in prose), fires its role's needs-input trigger (S25): one run per ask, where a declared block is one ask per pinned state line and a stall is one per settle, and the key clears when the session works again (`agentTasks.routeUpWaitingSession`). Any agent can also write to a role with `cast role wake @handle "<the request>"`. The role answers when it can. A role that cannot answer tells the role it reports to the same way: its own waiting fires its parent's trigger, speaking as the role. The role that reports to a person raises it in its own thread and nowhere else: its pinned state says what the person will decide and why (`cast state --status blocked`), and a real choice between options is a `cast decide` card posted there with the role's recommendation. That card reaches the person the role reports to, not whoever hosts its session.

**A decision travels the same way.** A `cast decide` posted by a session under a role fires that role's needs-input trigger, naming the session and the question (the waiting session's reason is "decision", with its short id); the role answers it when it holds the grant, or hands the same card up to its people: with the option it recommends, or passed up with no recommendation, and either way with a note giving the person what the role knows that the card does not say. The note shows on the role's line of the card's ladder; there is no second card and no separate surface. A role that does neither within five minutes hands it up by lapse, so a decision never waits on a role that stays silent. It reaches a person's queue at once only when the role cannot be told. A decision posted by a lead that reports to a person goes to that person.

**A role's own session belongs to whom the role reports to.** Reporting to someone is being in their inbox, so there is one fact, `reports_to`, and the standing session's owners follow it (`sessionOwners.stampSeatOwners`, called wherever a role's parent is set: provisioning, a move, a retire's re-home, the backfill `migrations:stampStandingSeats`). Under a person, that person is its only owner; under a role, it has no person owner and rides the parent lead's card. The owner gesture on a standing session refuses and names the role move, the owner menu there offers "Reports to" instead of an owner list, and writing to it never claims it. The machine and account it runs on stay separate: that is where it runs, not whom it answers to.

**Nothing waiting is lost.** When the route cannot reach a role (the person paused or cancelled its trigger, the role has no session, the org is off), the waiting session is the person's again: it notifies them as any session would. Sessions a role takes over that were already waiting route up when they move.

**What the person sees.** One card per lead that needs them, filed the way any session that needs input is: the standing session's own facts put it in needs input (a blocked declaration, an open prompt) or in questions (a pending decision in its thread; projection v14 stopped the anchor rule from hiding an asking standing session). Never the sessions under it, never a special block. The sessions under a role stay subagent rows under its card with no gesture of their own, and their settles ring nobody (`under_role`).

**What is gone.** `cast escalate` and `/cli/sessions/escalate`; `conversations.escalated_by_role` and every reader (the inbox projection's lift of a role's card, the `escalations` lines on the role's card and the phone's, the "with you" tag, Hand back and Put in my inbox, the role page's "Needs you" section, the digest's "In front of you", the CLI's escalation rows); `performEscalateSession` and its dividers. The `<session-escalation>` machine message keeps a reader only, so threads written before this still draw their dividers; the schema keeps the field optional until `migrations:clearEscalationStamps` has run in prod, then drops it. A session that moves under a role with a question to a person open no longer carries a stamp: the role hears about it as a line.

**A sub-lead rides its parent lead.** A role's standing session reports to what the role reports to. Under a role, the row carries that role's id in `org_role_id` (`lib/standingSeat.standingReportsToFields`, stamped on provisioning, on a role move and when a retire re-homes children; `migrations:stampStandingSeats` backfills seats from before the rule), so `isUnderRole` holds for it and it rides the parent lead's card exactly as a hand does: a sub row under the parent, never a card of its own in the host's inbox, whatever it declares; its settle rings nobody (`under_role`). Under a person the field is clear and the row is that person's own card. So the only card a person ever sees for their org is a role that reports to them, and what a sub-lead cannot answer reaches that top lead as a line in its thread. The org scan and `handsOf` leave standing sessions out of a role's hands, so a sub-lead is a child role on the page and the tree, not a hand.

**The decide sheet names who asks.** A decision posted from a role's standing thread reads as that role on the sheet and on the fold: its face and handle (`SessionDecisionCard`, the same `RoleFace` the inbox card draws), never "Waiting on your decision".

## S29. The health panel is a loop

Written 2026-09-30. The org page's health panel ("Company health", the staffing pane with no proposal open) had become a list of 126 findings in the capacity model's own words: live hands, cap hit days, breach 2, ledger 563 open, "(model: 3)", a roles-per-person bar and "roles under strain" chips. None of it said what was happening or what to do, and hands no longer exist as a word. The panel is now the loop the org runs on: roles look after areas, the Head of People watches the whole and proposes changes, the person decides. It shows that loop in this order, on stubbed data and on the real org alike.

**Needs you.** Only what a person must act on now: decisions the org routed to them (a lead's `cast decide` in its own thread, or one from a session under a role that no role could answer, read from the person's own decision queue), a role whose standing session declared itself waiting on a person, and a proposal still open that the pane is not already showing. A single-choice decision answers in place; everything else opens in one click. A decision and a blocked pin from the same thread are one ask. Empty, it says "Nothing needs you."

**Areas.** One row per role in tree order (the Head of People first, then each person's roles with their reports under them; retired roles left out): the face, the name, one status word, and the role's latest dated line from `## Where it stands` in its brief. The status is derived on the server from measures that exist in today's product and nothing else, most pressing first: *waiting on you* (its standing session declared blocked, or stopped on a prompt), *stuck* (a session under it waiting more than a day unanswered, a task in review more than a day, an open task whose session reported blocked), *overloaded* (more reached it this week than one role answers: `orgCapacity.isOverloaded`, said in words), *quiet* (nothing moved in its area for two weeks), else *on track*; *paused* and *not started* read from the role row. A row opens inline to its goals and progress (each project in its area with its goal and this week's counts), the sessions waiting under it (oldest first, each opening the session), at most three signals in plain words that change what a person would do, its check (last, next, pause, run now, the cadence editable in place, "change" to the trigger's page), and "Ask @role", one line into the role's own thread. Signals that matter only to structure (span, an unowned project, a stale record, a wide ledger) never reach a row; they are inputs to the Head of People's review.

**The Head of People's read.** Its latest read of the company: the `Company:` line it writes under `## Where it stands` at the end of every review (the prompt asks for it; the trigger's last run summary stands in until the first), its newest proposal with how far it is decided, the next review with its trigger (cadence editable, Review now, pause), and the composer into its thread, which is where a person iterates on the structure.

**One reading.** `org.health` carries the area beside the flags on every role row (`area`: status, status line, signals, the standing lines newest first, the waiting sessions, the goals, `checked_at`, the check trigger, the standing session), derived by `@codecast/shared/contracts/orgAreas` from the counts health already holds, so the panel, `cast org health` (which now prints areas and hides the counts behind `--json`), the Head of People's review and the area watch say the same thing about an area. The flags stay as the Chief's evidence and are reworded in the same plain terms: no threshold in a sentence, no hand, cap, ledger or breach word, no "(model: N)". The daily limit (S23.2) is the one operating word a flag still carries, as "reached its daily limit".

**Continuous.** The loop keeps itself current without the person asking. Signals are live, roles write their line at every check, and a change that lasts reaches the Head of People through the trigger system the way a waiting session reaches a lead (S28): one event trigger on the Head of People's standing session, "An area needs your review" (`lib/orgRoutine.HEAD_AREA_CHANGE_SPEC`, event `org_area_change`), armed with its routine and route up (`ensureRoleEventTriggers`), visible and controllable on its page, fired once per episode with the change in its frame (`triggerFrameFor` carries an `<area-change>` block beside the waiting session; the run block draws it). The area watch (`orgWatch.ts`, a cron every six hours) reads health for every workspace with a live Head of People, remembers each area's status on its role row (`org_roles.area_watch`: status, since, passes, told), and fires when a status that needs the Head of People (stuck, overloaded) has held across two passes in a row and was not yet told for this episode, and once for each project with work and no owner (`org_roles.unowned_told` on the Head of People, pruned when the project gains an owner). A paused or cancelled trigger, or a workspace with the org off, is not told and the episode still counts as told, so nothing fires twice when it comes back; the panel shows the status live either way. What needs a person (waiting on you) never goes to the Head of People: it is already in front of the person.

**What is gone.** The findings list, the roles-per-person bar, the strain chips, `spanOfControl` and `bottleneckRoles`, and every place the panel read a flag's detail to a person. `FLAG_LABEL` and the node badges on the chart stay for the flags that remain.



**An overload says why (2026-10-02).** A lead's overload alert ("11 sessions at once, 15 threads stuck, 3 days at its daily limit") did not say where the load came from. Health now names how each session under a role reached it, by the route S35 defines: `task` (bound to a task in its area), `plan` (bound to a plan), `filed` (`conversations.org_role_hold === "filed"`: a person's drag, the owner menu, `cast org reparent`, the role's own hand start), or `folder` (under the role with neither a hold stamp nor a binding: the retired folder rule put it there, until `migrations:releaseFolderHeldSessions` hands it back). The reading is `orgAreas.handRouteOf` over the row's own facts; `org.health` carries `area.reached` (counts by route) and `area.sessions` (each session with its route, capped at 40). The overloaded status line and signal end with `reachedSentence`: "Most of its 11 sessions reached it by the folder rule (9); the rest 2 through a task." The area watch's alert carries the status line, so the Head of People reads the cause in the frame; `cast org health` prints a `reached` line per role and the panel's opened row shows the breakdown.

**The Head of People reads a lead's standing session (2026-10-02).** It could not: `conversations.getThreadState` (`cast state show <id>`) accepted only a session the caller runs or owns, so a lead that reports to another person (Union's Agent Quality lead, hosted by Jason) answered "No session found" to the Head of People on Ashot's daemon (jx79zjy line 313). The read now takes the conversation's own access rule (`canAccessConversation`: run, own, or team-visible) through the ranked resolver; the write stays run-or-own. With `facts.standing` on the brief (S25) the Head of People sees a lead's state from `cast role show @lead` without a second read.

## S30. Head of People, and the Executive Assistant as the person's right hand

Written 2026-10-02, from the founder. The one root role carried two jobs: it reviewed the structure every week and owned the remainder (S6, S26, S29), and it was the person's right hand that answers anything and routes the rest (the opening in `headOfPeoplePrompt.ts`). The jobs come apart. The structure role is the **Head of People**; the **Executive Assistant** is the person's right hand, separate from it, and a person may have more than one. (The right hand was called the Chief of Staff for its first day; the founder renamed it the same day, which leaves `chief-of-staff` meaning one thing only: the Head of People's old handle.)

**Head of People** (`head-of-people`) is today's root role under a new name: one per workspace, proposes roles, scopes and record fixes in the weekly Company review, owns the work no narrower role covers (`isWholeWorkspaceRole`), reads the area watch (S29). Its opening loses the right hand paragraph and keeps the rest. The handle moves from `chief-of-staff` to `head-of-people` in `orgLead.ts` (`HEAD_OF_PEOPLE_HANDLE`; the old constant name stays as a deprecated alias for one release). A migration (`migrations:renameChiefOfStaffToHeadOfPeople`) rewrites every live or retired role row with the old handle (name "Head of People" where the name was the default "Chief of Staff", `handle`, the standing session's title through `seatTitlePatch`, and the review trigger's title and prompt where they carry the old words); it logs one org change batch per workspace. Old references keep resolving at ONE site: `rolesByHandle` in `lib/orgAccess.ts` answers either handle with the boundary's Head of People, always, and `handleTaken` keeps every other role off both, so `cast role wake @chief-of-staff`, `@chief-of-staff` in chat, a charter that sends unowned work to `@chief-of-staff`, and the anchor aliases all still land. The templates under `~/src/platform/packs` say `@head-of-people`.

**Executive Assistant** is a role (an `org_roles` row, so it has a face, a brief, a standing session, triggers, a page and a seat in the inbox like any role) marked by `org_roles.assistant?: { reach: "global" } | { reach: "team"; team_id }`. It names no scope and owns no work (S26 already allows the standing role). What tells one from another is where its row lives (ACCESS) and what it reaches (its brief and routine):

| kind | row lives in | reaches | who sees its thread |
|---|---|---|---|
| global (the default hire) | the person's boundary, `user:<id>` | every workspace the person is in | the person alone |
| personal, for one team | `user:<id>`, `assistant.team_id` set | that team's work | the person alone |
| team | the team's boundary, `team:<id>` | that team | every member; the hirer hosts it |

It runs on its host's daemon as every role does, so it sees exactly what its host can see and nothing more. The global one reaches across workspaces with no new query and no new grant: its session is personal, and it reads each workspace the way the person does from a shell, `--team` on every write and the read defaults of `resolveWorkspaceForRead` (CLAUDE.md, "reads may default, writes must be explicit"). The server never joins across boundaries for it; `listAnchors` already returns every row the viewer may see, personal and per team, and that is what the header draws from. A personal per team assistant is the same row shape with its working directory and brief pointed at one team. A team assistant's thread is team visible through the same chokepoint a team seat uses today (`patchConversationVisibility` in `provisionStandingAgent`). Several assistants may stand in one boundary; the default handle is `executive-assistant` for the first and `executive-assistant-<team slug>` for a personal per team one, and the hire form lets the person change it as for any role.

What an assistant can do is what the opening says today, scoped to its reach: answer anything, route a request in an owned area to that lead (`cast role wake @handle --team`), bring decisions with a recommendation, keep the person's goals in its brief, raise what needs the person in its own thread (S28). It never reviews the structure; that is the Head of People's. In team chat and Slack the "workspace's agent" (`@anchor`, `cast anchor say`, `anchor_channels`) is the team's Executive Assistant when one stands, else the Head of People, so a team with no assistant answers as before. `rootAgentOf` on the web follows the same rule.

**Names.** Every role shows a person like name with its role as the subtitle: "Ada · Executive Assistant, global", "Rowan · Head of People", "Ember · Growth lead". The stored `org_roles.name` stays the role title (every reader keeps working); a new optional `org_roles.given_name` is the name a person chose, and until they do the role wears `characterNameFor(role._id, avatarOf(role))` from `sessionCharacter.ts`, the same bank sessions already use, so no migration invents names and every role has one on every device. One reader, `roleIdentity(role)` in `@codecast/shared/contracts/orgIdentity.ts`, returns `{ name, title, subtitle }` (the subtitle adds an assistant's reach: "global", the team's name, or "personal, <team>"); the org node, the scope page header, the inbox card, the chat pill, the wake card, the proposal ghost, the header pin and `cast role show` draw from it. The hire form offers the name beside the face (the picker sessions have) and `cast role name <ref> <name>` sets it.

**Pins.** The app header pins roles or sessions. Storage is `clientState.ui.header_pins?: Array<{ kind: "role"; id } | { kind: "session"; id }>`, a stamped per user pref like `sidebar_pins` (one person, every device; an absent key is the default, never an empty list). The default pin is the person's global Executive Assistant when one stands; with none, the header keeps today's chip, the active workspace's agent, and that chip offers "Hire your Executive Assistant". A pinned role is drawn from the `anchors` collection (its seat row carries the role identity and the live status the chip reads now, `deriveAnchorStatus`); a pinned session from `sessions`. A pin whose row the viewer can no longer see (left the team, role retired, session gone) is not drawn and is dropped the next time the list is written, so access is still one equality per row and a pin grants nothing. Each pinned face opens the existing slide-over (`AnchorPanel`, generalised to take a conversation id instead of assuming the root agent) on its thread; `anchor.toggle` opens the first pin. "Pin to header" / "Unpin" sit in a role page's header menu and a session's header menu, and on the pinned face itself. The `useRootAgent` chip stays as the fallback and the onboarding cue; nothing else about the slide-over or `/anchor` changes.

**What this does to existing rows.** The rename touches every root role in prod, team and personal alike. The personal workspace's root (the person's own agent, S22) becomes a Head of People too, which is a structure reviewer of a workspace that usually has no leads; the alternative is to convert it into the person's global Executive Assistant, since that is what the person has been talking to. The migration takes `personal_root: "head_of_people" | "convert"` and does the latter only when told, so the choice is made per run, not by the code; a converted root takes the assistant's handle and name, since the old handle stays the Head of People's. A role the person already works with under another handle becomes their global assistant through `migrations:seatExecutiveAssistant` (`only` by short id, dry by default): it sets the mark and moves nothing else, so the name, handle, brief, standing session and triggers stay; the charter keeps its words except the one phrase that names the structure role by its old name ("the Chief of Staff's job"), which is brought up to date on the row and in the charter doc and put back on reverse.

**Both are findable in the hire gallery (2026-10-02).** Once a workspace has roles nothing offered the Head of People, and the Executive Assistant was offered only in the header. `TemplateGallery` leads its grid with two built-in cards (`templateCatalog.builtinHires`: `HEAD_OF_PEOPLE_HIRE`, `EXECUTIVE_ASSISTANT_HIRE`), ahead of every template and shown even when the catalog is empty; each disappears once one stands (a live Head of People among the workspace's roles, by either handle; a global assistant among the seats the person can see, `headerPins.globalAssistantOf`). Picking one opens the existing card in the dialog, through its existing path: `HireHeadOfPeopleCard` (the staff mutation) or `HireAssistantCard` (`hireExecutiveAssistant`), loaded on pick as the header panel loads them.

## S32. Knowledge handoff when roles change

Written 2026-10-02. A role's knowledge is its brief: its notes and the dated
lines under `## Where it stands` (`packages/shared/contracts/briefStanding.ts`).
When an accepted change moves an area (a project or a plan) from one role to
another, the knowledge moves with it, and nothing is lost in silence.

**What a move is.** The one ownership rule (S26, `ownerOf`) is read before and
after every write that touches a role's area: a retire, a scope edit, a hire
onto an area, a split (S34). Who held each area before and not after hands it
to whoever holds it after (`orgHandoff.ownerSnapshot`, `areaMoves`). Two roles
listing the same area are both its holders, so a move made in two edits (add
to the new role, then remove from the old) reads as one move at the second
edit, and a sibling gaining a share while the holder keeps it moves nothing. A
role that held the area only as the workspace's remainder and wrote no line
about it has nothing to hand over, and is not asked.

**What codecast does** (`orgHandoff.beginAreaHandoff`):

1. Copies the outgoing role's standing lines for the moved areas into each
   receiver's brief, under its own `## Where it stands`, marked and dated:
   `- Growth: two markets filled (from @growth) (2026-09-28)`. The parser
   reads `from` back, so a surface can draw the source; the receiver's own
   line for an area stands when it has one.
2. Records on each receiver which role it succeeded for which area
   (`org_roles.succeeded`: area, role, when, how many lines came, and when
   the rest came). The role page's Settings tab shows it as "Took over".
3. Arms one trigger on the outgoing role's standing session, run once in its
   own thread (`Hand over <areas> to @receiver`): hand each receiver what the
   lines do not say, in the shape `cast handoff` writes a brief (decisions and
   why, direction, verified and not, open questions, people and threads, next
   steps), delivered with `cast role handoff @receiver -`. The body lands at
   the end of the receiver's brief as `## Handed over from @outgoing (date):
   <areas>` and wakes the receiver with one line.
4. Marks the outgoing role `handing_over` (reason, deadline, receivers, the
   trigger). The role page shows the banner: who takes what, who has been
   handed, the deadline, "Hand over now" and "Close now".

**A retire waits.** `performRetireRole` with the default `handoff: "wait"`
begins the handoff and returns `deferred` instead of decommissioning; the
role stays active, its line starts nothing new, and a second retire while it
waits changes nothing. When every receiver has been handed to, or when the
deadline passes (24 hours; `orgHandoff.sweep`, every 15 minutes, closes it
with whatever was written), the retire runs as the person asked, with the
standing session kept or retired as they chose. `handoff: "skip"` retires at
once; a reset (S27) never hands over.

## S33. The morning agenda

A role with people reporting to it sets the day's agenda with each of them.
One recurring trigger on its standing session, "Morning agenda"
(`lib/orgRoutine.ROLE_AGENDA_*`), armed when the first person reports to the
role and paused when the last one leaves (`orgAgenda.syncRoleAgenda`, called
from `cast role reports` and with the routine), daily at nine in the host's
timezone (`nextMorningAt`). It is a real trigger on the role's page and the
Triggers page, controllable like its check: a person's pause or cancel stands.

The run reads each person's goals and what moved in their sessions since
yesterday (`cast brief`) and sends each ONE card they answer in a line: `cast
decide --to <person> "Agenda for today" --line "Your plan for today" --context
-`, where the context says how they progressed against each goal and names up
to three things for today. `--to` is new on `cast decide`: an addressed card
goes to the named people alone (resolved by name, email or id inside the
session's workspace, `sessionDecisions.resolveAskedPeople`); no role hears it
and nobody else is asked. `--line` is the one field form a person answers in a
line. Nothing from the agenda goes to the person the role reports to.

## S34. Split a role into two leads

One gesture, on the role page (Settings, "Split into two leads") and
`cast role split @role --into 'handle|Name|ref,ref' --into '…'`, turns one role
into two roles with disjoint areas split by projects or plans, both reporting
where the original did. `orgSplit.partitionScopes` insists the two halves are
disjoint, each own something, and together cover the whole area; the dialog
places every area on one side before Split is enabled.

The original gives up its area at once (so the halves own it by the rule from
that moment), the two roles are created with its switch, limits, line and
charter, each is seated on its own standing session, and the knowledge
handoff of S32 runs from the original to each half for the areas it takes,
with the retire waiting on it. A split is refused for a role with no area, a
role already handing over, and the Head of People or an Executive Assistant.

**As built (2026-10-02).** `HEAD_OF_PEOPLE_HANDLE`, `LEGACY_HEAD_OF_PEOPLE_HANDLE`, `EXECUTIVE_ASSISTANT_HANDLE`, `AssistantReach` and `isHeadOfPeopleRole` live in `shared/contracts/orgLead.ts`; the web (`orgStaffingTypes`), the CLI (`anchorAlias`, `orgInit`) and convex (`lib/orgAccess`) re-export them, so the handle has one home. The legacy rule is `rolesByHandle` in `lib/orgAccess.ts`: either handle finds the Head of People and nothing else, and `handleTaken` refuses both to any other role and to every assistant. `org_roles` gained `given_name`, `assistant` and `renamed_from`; `roleIdentity` (`shared/contracts/orgIdentity.ts`) is the one reader, and a legacy row still named "Chief of Staff" (`LEGACY_HEAD_OF_PEOPLE_NAME`) reads as the Head of People until migrated. The two openings are `headOfPeoplePrompt.ts` and `executiveAssistantPrompt.ts` (`lib/orgAssistant.assistantOpeningFor` fills a row's reach; `anchors.roleBootstrapOf` carries it as `assistantOpening`). Hiring: `orgRoles.hireAssistant` / `performHireAssistant`, `/cli/org/assistant`, `cast org assistant [--team] [--personal] [--name]` (`cast org chief` is a hidden alias), the web's `hireExecutiveAssistant` action and `HireAssistantCard` (the panel offers it until a global assistant stands; a personal workspace's onboarding hires the assistant, a team's the Head of People). The workspace agent rule is `anchors.isWorkspaceAgentRole` (`listAnchors.is_root`, `findExistingAnchor`, `@anchor` in `mentionResolve`). Pins: `clientState.ui.header_pins`, `lib/headerPins.ts` (`resolveHeaderPins`, `toggleHeaderPin`), `HeaderPins` and the generalised slide-over in `components/anchor/AnchorPanel.tsx` (`anchorPanel.target`), "Pin to header" in the role page's menu. The migrations are `migrations:renameHeadOfPeople` (`{dryRun, personal_root: "head_of_people" | "convert", reverse, only, scope}`; the charter doc follows the row, its default charter paragraph replaced and a person's kept, and a row renamed before the doc was part of the run gets the doc pass alone) and `migrations:seatExecutiveAssistant` (`{dryRun, only, reverse}`), tested in `orgRoles.assistant.test.ts`. `cast role update --given-name` names a role; `cast role show` and every surface print name then title.

## S35. How work finds its owner

Written 2026-10-02, from the founder's reading of the Union Calling lead:
every unbound session in `union-mobile/outreach` and every Aivery session on
the agent box landed under it because those folders were two of its projects'
folders, and it hit its daily token limit three days in one week reading cold
email and mailbox work that was never its. His rule: folders decide nothing.

### Holding

A role holds a session for one of two reasons and no other:

1. **Bound.** The session is bound to a task or a plan (`active_task_id`,
   `active_plan_id`, `plan_ids`) whose work the role owns by S26 (`ownerOf`
   over the task's plan and project). The session's folder is not part of the
   work: `orgOwnership.sessionWork` reads the task, then the plan, and
   nothing else. A session bound to nothing has no owner by the rule, whatever
   directory it runs in.
2. **Filed.** A person or a role put it there: the chart, the ownership menu,
   `cast org reparent <session> --under @role`, `cast route --to @role`, or
   the role's own line starting it as a hand (`spawn.recordHandStart`). A
   filed session stays filed until someone moves it; the rule never undoes a
   person's placement.

Otherwise a session stays with whoever started it. A project's folder
(`projects.project_path`) still names the team a new session in that
directory belongs to (`resolveTeamForPath`), still groups commits and
sessions for the Head of People's review (S9), and still tells `cast project`
where the work lives. It puts nothing under a role: the takeover
(`takeOverSessions`, `previewTakeover`), the scope's session list
(`org.sessionsInScope`, F1) and org health's attribution all read holding as
above, so a lead's scope feed shows what it holds and what is bound to its
area, never the folder's bystanders.

**Binding files.** When a session binds to work a lead owns (`cast task
start`, `cast plan bind`) and sits under no role, it moves under that lead
through the one reparent core, told the way a takeover tells it (S11). When
the binding ends (task done or dropped, plan unbound) and nothing else holds
it, it returns to its starter; a session that is done stays where it is,
because a done session is history, not load. A session filed by a person is
never moved by a binding either way. So "a lead holds it only when bound or
filed" is true at every moment, not only at the moment a scope changes.

**The folder is editable.** A project's folder shows on the project page
beside the lead chip and in `cast project show`, and changes with `cast
project update --path <dir|none>` or inline on the page
(`projects.update` / `projects.webUpdate` accept `project_path`; `null`
clears it). Changing it moves no session, because the folder holds none.

**The migration** `migrations:releaseFolderHeldSessions` hands back what a
lead holds only through the folder: every session under a live role, not its
standing session, not started by its line, whose work the role does not own
by task or plan, and whose last move in the org log was a takeover (a batch of
kind scope, role or hire) rather than a person's or role's own filing (a
batch of kind session, or a hand start). It returns each to its starter
(`owner_user_id ?? user_id`) through `performReparentSession`, one org change
batch per role, so History and `cast org undo <batch>` take it back. Dry by
default, filtered by `team`, `role` and `limit`, and the dry run names each
session, its state, why it is released ("folder: <path>" or "no record") and
whom it returns to. Its prod dry run is read by the founder before it runs
for real. Sessions with no log row at all are released too and marked "no
record", since every filing since the log exists has a row.

**Union.** The two Calling projects, Callers & Call Management
(`/Users/ashot/src/union-mobile/outreach`) and camerons ideas
(`/Users/ec2-user/src/union-mobile`), lose their folders (sd-338, answered
"well we should do this"). The Calling lead keeps the two projects, their
tasks and plans, and every session bound to them.

### Routing

Where new work lands, in order; the first line that applies decides, and
every landing says which line it was:

1. **Named.** Work addressed to a person or a role goes there: `--to @role`
   or `--to me` on `cast route`, an `@handle` in a chat line
   (`resolveChatMentions`, the role woken with `tellRole`), a task created
   with `--assignee`, a session a person reparents. Naming is filing.
2. **Anchored.** Work that names a task, a plan or a project is owned by
   `ownerOf` over that anchor (S26): the role naming its plan, else its
   project, else the Head of People. A task inherits its plan's project; a
   session its task's work; a request its `--task`, `--plan` or `--project`.
   A task a session files for people without an assignee goes to the role the
   session works for, else the person running it (`defaultSessionOwner`).
3. **Started.** A new session with no binding and no filing stays with the
   person whose daemon started it. A chat line that names nobody reaches
   nobody (a channel a role follows is the role's own reading). A task a
   session files for its own bookkeeping stays unassigned.
4. **Read.** A request that is none of these, from `cast route` or
   `POST /cli/route`, is read by the semantic router below. It files where the
   router is confident; otherwise it answers with the top choices and files
   nothing.

**`cast route "<request>" [--to @role|me] [--task ct-N|--plan pl-N|--project
<ref>] [--team <name>] [--dry] [--json]`** applies the rule to one request and
says where it went and why. It lands a request as a task in the owner's area
(the anchor's project when there is one), assigned to the owner (a role's id
or the person's), and wakes a role with one line naming the task
(`performWakeRole`) so the role starts it or recommends it, by its switch
(S23.1). A person as owner sees the task on their board. The output is one
line (`→ @cold-email · line 2: pl-54 names the plan Warm the sender pool`) or
JSON `{ owner, line, why, task, woke }`. `--dry` prints the landing and writes
nothing. `POST /cli/route` is the same call for scripts and systems outside
codecast (an api token in the body, as every `/cli` route), so an inbound
email, a form, or a webhook handler can hand codecast one request and learn
who has it. The rule itself is pure and lives in one place,
`packages/shared/contracts/orgRoute.ts` (`routeWork`), beside `ownerOf`; the
server (`orgRoute.ts`), the CLI and the health attribution read it.

### The semantic router

When line 4 is reached, one model call reads the request against the roles
of the workspace: each live role's name and handle, its charter, its area
(project and plan titles with their goals), the dated lines under its brief's
"Where it stands", and the titles of what it holds now. The prompt is one
principle: name the role whose charter and current work this request belongs
to, say why in one sentence that cites the charter or the work, and say how
sure you are; a request that no role's charter covers belongs to the Head of
People when it stands for the workspace, and to the person when nothing does.
It answers `{ handle, confidence, reason, alternatives }`. Confident
(`confidence >= 0.8` and the runner-up at least 0.3 below) files; anything
else is returned to the caller as choices with reasons, and the CLI, at a
terminal, lets the person pick one. The call runs on `CHEAP_MODEL` through
`callModel`, is logged like every surface, and is a surface of `./evals`
(`route`): freezes are real Union requests with the roster as it stood and the
owner a person confirmed, gated on a well-formed answer naming a live handle,
judged on whether the reason cites something the roster says. No change to
the prompt is called good without a run that separates from the baseline.

**As built (2026-10-02).** The rule's readers: `lib/orgOwnership.sessionWork`
reads a session's task, then its plan, and nothing else; `org.sessionsInScope`
lists bound and filed sessions; `holdChangeFor` says what a binding does to a
hold and `sessionOwnership.applyHoldChange` applies it through the reparent
core, scheduled (`internal.sessionOwnership.reconcileHold`) from a task start
(after `claimTaskOwnership`), a task closed (`updateStatus`, `cascadeClose`), a
plan bound or unbound (`plans.bindSession`, `unbindSession`), and a session
created on a task (`dispatch.createSession`, `tasks.run`). The stamp is
`conversations.org_role_hold` (`bound` | `filed`), written by the reparent
core's role target (`hold`, default `filed`; a takeover passes `bound`), by a
hand start (`filed`) and cleared with the role pointer. The folder is edited
with `cast project update --path <dir|none>` (`projects.update` and
`webUpdate` take `project_path`, `null` clears) and inline on the project page
under the lead chip. The migration is `migrations:releaseFolderHeldSessions`
(`{dryRun, team, role, limit}`): it skips killed rows, keeps bound sessions,
filed sessions and hands (a line run's `workflow_run_id`, a parent chain to
the standing session, or a first message that opens with
`spawn.HAND_BRIEFING_HEADER`), names the change whose takeover moved a session
by reading `effects.takeover.sessions` once per boundary, and counts
`release_live` as status active with a pinned state that is not done. The
routing rule is `contracts/orgRoute.routeWork` (`landingLine` prints it); the
server is `orgRoute.route` (an action: `internal.orgRoute.prepare` resolves
the caller, the target and the anchors and builds the roster; a landing is
`tasks.create` plus `orgRoles.wake`) behind `/cli/route`; the CLI is
`routeCommand.ts`. The router is `lib/orgRouter.ts` (`routerRequest`,
`parseRouterReply`, `routerDecision`, `ROUTER_CONFIDENT` 0.8 and
`ROUTER_MARGIN` 0.3 over the runner-up's own confidence); its eval is the
`route` surface (`packages/evals/src/surfaces/route`, refs
`route@<team>:<ct-N>` and `route@fixture:<case>`; gates `parse`, `no-misfile`,
`owner-known`).


## S36. Goals on the chart, and the chart beside a conversation

Written 2026-10-04. The chart drew who reports to whom. It now also draws
what the company is trying to reach and who answers for each part of it.

### Two lenses, one canvas

The chart has two lenses, switched by a toggle in its toolbar and by
`?lens=goals` in the URL: **People** (the reporting tree, as before) and
**Goals**.

The Goals lens is an outline on the left and a column of owners on the right:

- The company is the root. There is no purpose row in the data, and none is
  added: the top level goals (initiatives with no parent) are the purpose, in
  the same sense the proposal card uses ("purpose first, then what feeds it").
- Under the company, each top level goal; under a goal, the goals that feed
  it (one level, `parent_initiative_id`), then the projects that carry it
  (`project_ids`, in the owner's order). A project several goals carry is
  drawn once (`projectRows`): under the goal nearest the work (the deepest in
  the outline); among those, under a goal that carries it today before one a
  proposal would set; then under the goal whose owner leads the project; else
  under the first in the outline. Every other goal that carries it shows a
  small reference chip naming where it is drawn. A purpose set over every
  project would otherwise repeat the whole list above the goals that answer
  for each. A row an `initiative_projects` change adds is that change's one
  mark on the chart, so it is always a row.
- Siblings read in the order the proposal card reads them: live goals in list
  order, then what the proposal sets or moves, by its number in the proposal.
- On the right, one card for every person or role that owns a goal or leads a
  project, level with the first thing it owns (the purpose's owner sits beside
  the purpose). A goal belongs to its owner (`initiative.owner`) and a project
  to its lead (`projectLeadOf`, the one rule the project page uses), when the
  project names the lead or the lead's scope lists it. The whole workspace
  fallback (a head of people with no area) covers every project by the rule,
  so it is no lead here.
- The trunk from a card to its children drops from under the card and runs
  down the gutter left of the children, so it never crosses a card.

Why a toggle and not goals as a band above the roles: a band keeps both trees
on screen, so every owner edge has to cross the reporting tree to reach its
role, and a company with five goals and fifteen projects draws twenty edges
over the cards. In the outline the picture answers one question: who owns
what. The reporting line is one click away in the other lens, and an owner
card opens its seat there. The outline is also tall and narrow, which is the
shape of a pane beside a conversation.

The resting chart draws no owner edge. Every goal wears its owner's face and
every led project its lead's, so a line from each across the canvas would
repeat what the card says and bury the outline under curves. The canvas draws
the owner edges of one card at a time (`goalsFlowEdges`): the card under the
pointer, else the selected card, else the card of the change in focus.
Pointing at an owner shows everything it owns; pointing at a goal or a
project shows who answers for it. The edge leaves the row's right side, runs
out past the deepest row and curves to the owner, through the empty band
between the two columns.

### Goal ghosts

The lens draws the goal tree **as it will be** once the open proposal is
accepted, with every changed thing in the ghost chrome role ghosts wear
(the violet tint, the plain word). This is the same reading the proposal card
gives, because both come from one resolver: `proposalChangeRows`
(`proposalTree.ts`) names each goal change's goal, parent, owner and former
parent, one row per change. The card joins and nests those rows
(`proposalTreeRows`); `goalsPlan` (`goalsLayout.ts`) places them. Nothing
resolves a goal ref, an owner ref or a parent a second time, and a tag reads
the same word in both places.

| Change | Drawn as |
|---|---|
| `initiative` | A ghost goal under its parent (or under the company), the word "new", its projects as ghost rows beneath it (or reference chips, when a live goal already draws them), its owner's face, a violet line for its metrics |
| `initiative_shape` with a parent | The goal under its new parent, tag "moves here" (or "to the top"), with a line "was under X" |
| `initiative_shape` with metrics | A violet line on the goal: the metrics and their targets |
| `initiative_projects` | Ghost project rows under the goal, tag "added" |
| `initiative_owner` | The new owner's face on the goal and a violet line "owner X"; pointing at the goal shows a violet edge to the new owner and a faint one to the old |

A proposed change is a ghost, an accepted one is drawn solid until the store
carries it, an applied or skipped one draws nothing. An owner nothing answers
to is a warning tag on the goal, never a dropped change. A click on a ghost
focuses its change, the way a role ghost's does: the chip is pressed and the
conversation's card for it lights. The map carries no answer controls; a
change is answered on its card in the conversation (S41).

### The chart beside a conversation

The map beside a conversation is the org screen itself (S41) with `?beside=`:
`openOrgChart` (`components/org/orgChartLink.tsx`) opens
`orgScreenPath({ show: "map", beside: session })`, and the screen draws the
map alone when the pane sits beside the Head of People's own thread. It is an
ordinary route, so the stage hosts it as a pane beside a conversation
(`openIn("split", …)`, the one reused target pane, opened unfocused so the
conversation stays primary). It
opens from a proposal card ("Map") and from the session header (a chip that
appears when the thread holds a proposal). On a dev build `preview=1` draws
the fixture org, as it does on the org page.

Its address is its whole state: `proposal=op-N` draws that proposal's ghosts,
`focus=` pans to one thing (a change by its number in the proposal, a goal by
`in-N`, a role by `@handle`), `lens=` picks the lens (absent, the lens the
focus or the proposal's changes call for), and `beside=<conversation>` names
the conversation it follows.

**How the agent drives it.** The pane follows the thread it was opened from:
it reads that conversation's messages from the store and points itself at the
newest pointer in them. A pointer is something the agent already writes:

- `op-N` on its own line (the proposal card): the pane shows that proposal.
- A link to the chart, `/org?proposal=op-N&focus=3`: the pane shows that
  proposal and pans to that change. The agent writes this when it wants the
  person to look at one thing while it talks about it.

No server state, no new message type and no new channel: the pointer is
message text, the pane's state is its URL, and the follow is a read of the
local store. The person keeps control: the pane only moves when a newer
pointer arrives, anything they click or toggle in it holds until then, and
"Following" in its bar turns the follow off.

## S37. Semantic zoom: one picture, read like a map

Written 2026-10-04. A card on the chart says more the closer you look. The
canvas zoom picks one of three levels for every card (`orgZoom.ts`,
`useZoomLevel`), and nothing else changes: there is no second view.

| Level | Zoom | A goal | A role or a person |
|---|---|---|---|
| far | under 0.55 | The title, large, and its health dot | The name, large, and one dot in the seat's colour |
| middle | 0.55 to 1.15 | The card: owner face, the first metric against its target, the health word, how many projects carry it, a line per proposed change | The card as before: standing line, area, session counts |
| close | from 1.15 | Under a rule: the description, every metric with its latest value, trend and date, the next milestone, the latest update in its owner's words, the sessions working under its projects now. A project row adds its number, status and lead; an owner card its standing line | The line under the name moves to a row of its own so the name, the title and the session count read whole; the changes on the card become a line each instead of a row of chips; then the charter line, the role's open work (open tasks, in flight, active plans: `org.health`'s ledger for its area) and the sessions running now |

The goal card's health, metric, milestone and update lines are the intent
layer's atoms (`InitiativeAtoms`: `HealthChip`, `MetricReadingLine`,
`MetricTile`, `NextMilestoneChip`, `UpdateLine`), so a goal reads the same on
the chart as on its own page.

**Each level has its own layout.** A card is a fixed size at each level, and
the layout is computed for the level on screen (`layoutGoals(input, level)`,
`layoutOrgTree(tree, view, ghosts, level)`): a far goal is its title alone
(`goalFarHeight`), a middle card is the card, a close card adds the close
rows. So the resting chart keeps no room for what only the close card says,
and about twice as much of a company fits in a pane as when every card
reserved its close size. Zooming inside a level moves nothing.

**Crossing a stop is anchored.** When the zoom crosses a stop the layout for
the new level replaces the old one, placed so the card under the pointer
stays exactly where it is (`bandOrigin`, `orgViewport.ts`; with no pointer on
the canvas, the card nearest its centre). The other cards slide to their
places around it (the `.org-flow` node transition, 260ms) and the edges
follow. The canvas itself is not moved, so a pinch in progress is never
fought, and the layout's origin simply travels with the anchor. A card
subscribes to the level, not the zoom, so it re-renders when the zoom crosses
a stop and never on a zoom tick. On the Goals lens an edge meets a card at a
fixed distance from its top (`goalsAnchor`), which is inside the card at
every level. Titles are measured the way the browser wraps them, by word
(`wrappedLines`), so a two line title never pushes a row out of its card.

Close is for reading, so a close card never cuts a name or a count: the
close layout books the rows the text needs (`roleCloseExtra`, `personCloseExtra`,
with `roleMetaLine` wrapped by word), and a name takes a second line before
it is cut. A session row names its state in words at every level, beside the
colour of its edge.

The health map (`structureOnly`) has one level: its cards are the same size at every zoom.

## S38. A role keeps a playbook and tunes its own wake

A role that runs for months learns things its next run would otherwise learn again: which diagnosis was wrong, what the person already decided, what was chased and found false. One long running session kept all of that by rewriting its own trigger prompt, 51 times, until the prompt was 154 KB and every wake reloaded it. The idea is right and the home was wrong. The learning belongs in the brief, which the role already reads at every wake and already writes at the end of every check, and it needs a budget.

**The playbook is five sections of the brief**, written by the role with `cast brief edit -`, beside "Where it stands". Each is a list, one line per entry, and each line carries its date, so the wake frame, the role page and the learning loop read the same sentences (`packages/shared/contracts/rolePlaybook.ts`, built on the `briefStanding.ts` line reader).

| Section | A line holds |
| --- | --- |
| `## North metric` | A first line naming the one number the area is read by, then one reading per line, dated. The role keeps the recent readings and the milestones and drops the rest |
| `## Rules learned` | The rule, the mistake that taught it (`Learned from:`), the date |
| `## Refuted` | What turned out false and what showed it, the date, so it is not chased again |
| `## Standing decisions` | What was decided, who decided it, when |
| `## Open threads` | What is open and what it waits for, when it opened, when it is due |

A section the role has nothing for is left out. `cast brief` prints the shape of an entry in each section under the brief, at every read, so the format lives in one place and the wake prompt carries none of it. It prints them every time, not only for a section the brief lacks: in the first dry runs the shapes showed only for missing sections, and a role condensing a full brief kept the facts and dropped every date and every "Learned from", which left a brief no reader could parse.

**The brief has a size budget** (`BRIEF_BUDGET_CHARS`, 12,000 characters, about 3,000 tokens a wake). `cast brief` says how full it is once it passes three quarters. A save from the role's own session that is over the budget is refused with the reason, so the role condenses before it grows: it merges rules that say one thing, drops closed threads, and thins old metric readings down to the milestones. A person editing the brief on the role page is not capped.

**How it wakes has one home: the routine itself.** The cadence, the precheck, the focus, and the reason for the last change are fields of the role's check trigger, never sentences the role repeats in its brief. `cast brief` and the role page print them from the trigger, so what the playbook says about the wake cannot drift from what the wake does.

- The focus is the role's own part of its wake: a short text (600 characters at most) the frame carries after the routine's prompt. The routine's prompt stays the product's, so a prompt change still reaches every seated role, and the role's part can never grow past its cap.
- `cast role tune --every <1h to 7d> --precheck "<command>" --focus "<text>" --why "<reason>"` changes them. It takes no trigger id: from a role's session it finds that role's own check and nothing else, so a role never reads or writes the person's roster of triggers to tune itself. A reason is required.
- Inside the bounds the change applies at once, with no proposal. It is one row in the org log (`routine_tune`: the cadence, precheck and focus before and after, and the reason), so the person sees it in History and on the role's page, and takes it back with the same undo as any other change. It is also a revision of the trigger, so `cast trigger history` shows it.
- Outside the bounds (a cadence under an hour or over a week) the command refuses and says to propose a `routine` change, which the person accepts like any other. An accepted routine change that names the role's own check changes that check through the same writer (`applyRoutineTune`); it never arms a second trigger beside it.
- A tune made from inside the check's own run is taken (the trigger is `running` then): the cadence, the gate, the focus and the reason are the only fields a running trigger accepts, and the new interval counts from the arming after that run.

**The check ends by keeping the playbook.** `ROLE_CHECK_PROMPT` gains two short lines at principle level (`ROLE_PLAYBOOK_LINES`): the role ends a run by revising its brief with what the run taught it and keeps it short enough to read every time, and it changes its check when how often it runs no longer fits how fast the area moves. The prompt names no section and gives no example; the shapes come from `cast brief`. The lines are proven on the `role-wake` eval surface with four fixtures (a steady area that taught a rule, the same run on a brief with no playbook yet, an area gone quiet, a brief at its budget), old prompt against new, 8 reps a side, gates decided in code: every entry parses with its date and a rule with what taught it, the brief fits its budget, the role tunes when the rhythm changed and leaves its cadence alone when it did not. What the runs showed (2026-10-05, Sonnet 5.5): without the wake line no rep of 32 slowed a check on an area frozen for five weeks; with it 8 of 8 did, with a reason, and 0 of 24 on the other fixtures tuned at all. The playbook line itself moved no gate: the roles wrote dated rules with their mistakes under the old prompt too, because `cast brief` prints the shapes. A first draft of the wake line ("when it does, leave it alone") tuned 3 of 8; saying what a check costs moved it to 8 of 8. The Head of People's weekly review keeps its own prompt unchanged: it reads the same `cast brief` and may tune itself the same way, and its prompt changes only with a run of the `org-review` surface behind it.

**Rules feed the template learning loop** (org-hire.md H12). When a role hired from a template stands in an opted-in workspace, the pass reads the rules it learned since the last pass as one more signal beside what people typed and where the hire stalled. The model generalizes them into lessons about the template; every lesson still goes through the leak check, and a rule is read once (its key joins the instance's `seen` list). A role that was not hired from a template feeds nothing.

**The role page shows it.** The Overview carries a Playbook block under "Where it stands": the metric with its readings and milestones, the rules with what taught each, what was refuted, the standing decisions with who and when, the open threads with a due date that turns yellow when it has passed, and a line for how the role wakes and why, with the date it last tuned itself.

## S39. A proposal's changes as cards, one per subject

Written 2026-10-05. A proposal used to draw its changes as a small tree in a conversation and as one row per change on the org page. A person does not decide rows. They decide what happens to a role, a goal, a project or a record, and two rows about one goal (move it, then give it a project) read as two decisions where there is one. So the unit a person reads and decides is the subject, and every surface draws the same card for it.

**One card per subject.** `proposalSubjects(changes, live)` (`components/org/proposalSubjects.ts`, pure, built on `proposalChangeRows` so no ref is resolved twice) groups one proposal's changes by what they change:

| Changes | One card for |
| --- | --- |
| Everything on one handle: a new role, its move, what it looks after, its routine, its session, a retirement | that role |
| A new goal, where it sits, how it is measured, the projects that carry it, its owner | that goal |
| A project's priority, lead and status | that project |
| A plan's status, and where it is filed | that plan; the tasks it closes ride with it, named under "Closes with it" |
| A task's status | that task |

A limit is never a row or a number on a card (S23.2): it rides with its role's card and is decided with it. A proposal that holds only a limit draws one plain sentence. A removed change is in no card. Cards are ordered goals, projects, roles, plans, tasks; goals and roles parents first, projects by the priority the proposal leaves them with.

**What a card says.** One sentence, verb first, naming the subject: "Make Platform the top priority.", "Move Activation under the purpose, give it two measures and have Onboarding carry it." The sentence is the shared contract's (`changeSentence(change, { brief, names })` in `shared/contracts/orgProposal.ts`), so the card, the log and the shell say one thing; a card whose lead change creates its subject uses that change's sentence alone. Under it, a row per field the changes move, with what was there before and what replaces it, then the reason each change gave, the sources behind one control, and the answer controls: Approve, Reject and Reply. The field labels read aloud with their value (Priority, Sits, Owned by, Measured by, Carried by, Reports to, Looks after, Starts work, Runs, Session, Status, Led by) and never say scope, charter, limit, a change number or a kind name. A measure's target is drawn as its author wrote it. A goal with sub goals in the same proposal does not list its projects: it says how many, "through the goals below", and opens to the list. When a proposal sets one top level goal and places other goals under it, that goal is "the purpose" in every sentence that names it. The number beside a card is its place in the list, not a change number.

**A card is answered, and the answer covers the card.** A person approves a card, rejects it, or writes back on it; a rejection or a reply takes the person's words in a field that opens under the entry (the decision card's typed answer is its model). Nothing fires on the click. The answer joins the conversation's pending batch, `reviewComments[conversationId]`, the one home for what the next message carries, which the quote UI already owns: one item per card (answering again replaces it, approving with no words a second time withdraws it), drawn in the composer's tray (`ReviewBar`) as the reply being built, approvals folded into one row, each rejection and note with its words. "Approve the rest" at the foot answers every card that still waits and has no answer; Reply at the foot is a note on the whole proposal, which is also how a person asks. A card with a pending answer never looks decided: only the pressed control and the quiet line "on your next message" change.

**One send does three things.** The composer's send (Enter, or the button, with nothing typed) takes the proposal answers out of the batch first (`takeProposalAnswers` in `lib/reviewActions.ts`), then the quotes, then the typed words. For each proposal it calls one mutation, `orgProposals.reply` (`performReply`): human only, the proposal open, `refuseIfRevised` checked once for the whole reply over the `seen` stamp built from the store's rows. Rejections skip their rows (`skipOne`) and stamp the answer; notes stamp the answer and decide nothing, so the row still waits; approvals run as ONE `performAcceptAll` narrowed to their seqs, in apply order, with its chunking and continuation, as one line of history under the gesture `reply`. The message that leaves is `proposalReplyText` (`shared/contracts/orgProposal.ts`), one block per proposal: the approvals applied in one line, each rejection and note on its own line with the change's `op-N#seq`, its sentence and the person's words, and a note on the whole proposal last. The refs render as pills in the person's bubble and give the agent what it needs to revise with the commands it has. An approval is not taken back from the card; the way back is the org record's Undo (S21). Edit in input materialises quotes only and leaves the answers in the tray, because a verdict turned into text would send words and apply nothing; Clear discards both.

**The `reply` stamp.** The change row keeps what the person said: `org_proposal_changes.reply: { verdict: "approve" | "reject" | "note", text?, at, by? }`, read while `reply.at` is later than the row's last revision. So the card says the state in words after a reload and on another device: Approved (cyan while it lands, green once applied), Rejected and then the words, Noted and then the words with "waiting for a revision", Failed with the note and Retry. When the author amends a change the person wrote back on, the card reads as revised and can be answered again. The server's status names stay `accepted` and `skipped` under the words a person reads; "Skip" and "Accept" appear nowhere a person can read.

**Where no composer is in reach.** (Superseded by S41: every answer is given on a card in the Head of People's conversation on the org screen, and a proposal from another thread answers from the strip into that conversation's batch.) The org page panel with the thread column closed, `/company`, and a proposal a person posted have no conversation composer, so `ProposalReplyBox` (`components/org/ProposalReplyBox.tsx`) draws the same tray rows, a small reply field and the one send. Its batch key is the proposal's thread conversation id, so an answer given on the org page and one given in the Head of People's thread are the same batch; with no thread the key is `proposal:<id>`, the verdicts apply and nobody is told, and the box says so in one quiet line. Its send carries `say` to the mutation, which builds the reply text from the rows and sends it into the proposal's thread through the path `performSayInThread` uses, so the agent still receives one message. The org page's panel takes the same answers on the cards of each ask; a closed ask's Approve puts one answer over the ask's seqs. The org page preview keeps its own handlers.

**One component, four places.** (Superseded by S41: one place, the card in the conversation.) `ProposalSubjectCard` is callback driven and reads no store: it takes this card's pending answer and an `onAnswer` callback, and each host keys them to its batch. The hosts: the proposal card in a conversation (the letter's lead, the cards on hairlines, then a closing row with Chart on the left and "Approve the rest", Reply and, once the batch holds an answer for this proposal, "Send N answers" on the right; when nothing waits, the outcome in words, "7 approved, 2 rejected"), the org page's panel (the cards of each ask; a proposal with one ask draws them straight under the title), `/company`, and the chart's ghost strip, which reaches the same batch through `useGhostAnswers` (`ProposalLedger.tsx`): a change's answer is the answer of the card that holds it, numbered as the ledger numbers it, so a ghost answered on the chart shows pressed on the card and in one tray row. `answerProposalCard` keeps one answer per change across every surface: putting a card's answer withdraws any other card's answer over the same changes (the panel's ask over a card inside it, the chart's ghost over the ledger's card). `useSubjectLive` (`proposalHooks.ts`) is the one place the live records a card compares against are gathered.

**One change, by its number: `op-N#seq`.** A change's number is its `seq`: given at create, kept through an amend and a remove, never reused, and printed by `cast org propose` and `cast org apply` as `#n` beside each change. The ref is the grammar the server already used (`findChange`, and its error lines), now parsed in one place (`parseProposalChangeRef`, `shared/entities`). It types as a proposal. In a sentence it is the proposal's pill with the number after its title, and it opens the org page with that change in focus (`/org?proposal=op-N&focus=n`; `#` in a URL is a fragment, so the link never carries it). Alone on its line it draws the card of the subject that holds that change, with every other change to the same subject: a second unit of verdict would leave riders behind, and a change that only makes sense beside its sibling reads cold. That card has no frame around it and no list: a line saying where it sits ("First of nine in" and the proposal's title as a link), the card and its controls; the answer shows in the composer's tray, and there is no closing row. A number the proposal does not have, a removed change and a proposal the reader may not see each draw one quiet line. The Head of People's prompt teaches the form in one sentence (`head-of-people-prompt.md`, "Talk it through"); the number it writes is the one `cast org propose` printed, never the change's place in the spec it posted, because the parser may fold two spec rows into one.

**The before stamp.** Before an approval is applied, "what was there before" is the live record. After it, the live record is the new value, so a card that kept reading it would say "top priority, was top priority", and any later edit to the record would rewrite what the card says the person agreed to. So the apply stamps what it moved on the change row: `applied_diff` on `org_proposal_changes`, written by `acceptOne` in the same transaction as the apply, so a throw discards both. It is not computed a second time: the apply's own log rows are caught as they are written (`takeOrgRows`, `lib/orgChangeLog.ts`) and cut by `orgAppliedDiff` (`shared/contracts/orgChange.ts`) to the fields a card draws (`ORG_DIFF_FIELDS`), with the name of each id they mention and the log batch. A goal change's record lists are stamped as the entries it added, never as the whole lists. Nothing is stamped for a rejection, a failed apply, an apply that moved nothing, a limit, or a row applied before the field existed.

**A decided card reads the stamp.**

| The change is | Before comes from |
| --- | --- |
| waiting, or failed (a failed apply wrote nothing) | the live record |
| approved, not yet applied | the live record; a field that already reads as the new value is drawn with no before |
| applied | the stamp; with no stamp, only what was set |
| rejected | nothing: the card shows what was proposed |
| any, in a proposal of another workspace | nothing: the reader's own records are not that company's |

**Order of shipping.** The fields are optional, so Convex goes first and an older web ignores them. A change ref on a client older than the renderer is the proposal's pill followed by plain text.

Left out on purpose: an Undo on a decided card (the stamp carries the batch for it).

## S40. The map: one picture of the company

Written 2026-10-06. The founder asked why goals, projects and the org chart
were separate pictures: "a single view with everything on it; we can filter
it down to just one or the other". The chart's two lenses (S36) are now one
map with three filters and one overlay. The word a person reads is goal; the
top one, a goal that other goals feed, is the mission.

**One component.** `OrgMap` (`components/org/OrgMap.tsx`) draws the map
and keeps nothing but its own selection: the page that mounts it (the org
screen, beside the Head of People's conversation, or beside another
conversation under `?beside=`) passes the tree, the goals, the open proposal with its
changes, the filter, whether the proposal is overlaid, and the change a card
in the conversation is pointing at. It is read only: nothing on the map
decides a change; answers happen on the cards in the conversation.

**The spine is Mission → Goals → Projects** (`goalsLayout`). A sole mission
is the outline's root and wears the company's name and totals; several top
level goals, or none with goals under them, keep the company card over them.
Every goal wears its owner's face; a project row its lead's. The projects no
goal carries sit under one quiet header at the foot ("6 projects under no
goal"), because they are real work and what a goals proposal is there to
place. A goal with goals under it names no project ("9 projects through the
goals below"); a goal whose carried project is drawn elsewhere says "also X".

**Sessions are counts and words, never a wall of cards.** A project row
carries the sessions of the roles whose area holds it; a column card its
own. Each says the state a person acts on first ("4 need input · 2
working", `stateWords`), with the bar for the proportion and the whole tally
on hover. On the People filter the reporting chart draws no session stacks
(`view.sessionCards: false`); the cards say the same words.

| Filter | What it draws |
|---|---|
| Everything (default) | The outline, and beside it every person and active role in a fixed order (people, me first; roles by name): face, owns N, "under X" for a role, sessions in words. The order does not depend on the proposal, so the column reads the same with the overlay on and off |
| Goals | The outline alone |
| People | Who reports to whom: `layoutOrgTree` with the counts on the cards |

**As proposed** overlays the open proposal on whichever filter is on, in the
quiet violet mark every proposal wears: goal changes through `goalsPlan`
(S36), role changes through `ghostsFor` on the column cards (a proposed role
is a stub card, a retire hatches, a move says "under X" and "was under Y", a
scope or charter change is a quiet line). A moved goal keeps a faint line
from where it was. It is on whenever a proposal is open; `proposed=0` in the
pane's address turns it off. Semantic zoom (S37) is unchanged: the mission
kicker, the words and the column rows are booked at every level.

**A card in the conversation points at the map.** Hovering or focusing a
proposal card passes its change as `highlightChangeId`: the node that
carries it lights with the selection ring and its owner edge, and the map
pans only when the node is off screen, so a pointer moving down a list of
cards never drags the map about. A link in the thread (`?focus=N`) lights
and pans always. Whichever happened last wins.

**What this retires.** The chart pane's lens toggle and its reply box at
the foot (answers live in the conversation), the action strip on goal and
project cards, and the owners column that pulled each owner down level with
the first thing it owned.

## S41. The org screen: one conversation, one map, one way to answer

Written 2026-10-07. This section replaces S5 (the staffing pane and the ghost strips), the asks column of S19, the "Where no composer is in reach" and "One component, four places" parts of S39, and the chart pane of S36. Those sections stay as the record of how the surfaces got here; what they describe is gone from the tree. S40 describes the map itself.

**Why.** By October the org page drew a proposal on nine surfaces, offered eight ways to approve (one of them, Edit, applied at once), turned a change into words in six places, and listed no open proposals at all. The Head of People's conversation was mounted only behind a `?proposal=` link, in a narrow panel column, cut to the messages after the proposal. A person opening the page could not see what waited on them, could not read what was proposed, and could not tell whether pressing Approve applied anything.

**One screen.** `/org` is `OrgScreen` (`components/org/OrgPage.tsx`): the Head of People's standing conversation on the left, the whole thread, live, through the same `AnchorConversation` a session uses (bootstrap and working turns folded, no sticky prompt, opening at the live tail), and the map (S40, `OrgMap`, read only) on the right. The header is the name, the mission (the one root goal with children, `missionOf`) and three controls: Health, Add a role, and a menu with History, Words and the gallery. With no Head of People the left column is the hire card and one "Propose an org now" line, the one home of that call to action. The column's states, in priority order: refused, error, loading, no head, not started, preview, live; the head row and the strip paint from the org tree at once, and the column seeds the conversation row the moment it knows the id so a cold open never sits on "Loading conversation". Wide (980px and up) the conversation fills (at least 560px) and the map takes 40%, capped; under that the two stack behind a Conversation | Map switch. When the screen is a leaf in a stage split, its sibling panes fold to a rail while it is open and come back when it leaves, so the conversation has room to read a card. Opened beside a conversation from a card's Map word or the session header chip (`openOrgChart`, `/org?show=map&beside=<conversation>`), the map column follows the newest `op-N` pointer that conversation writes, with a Following toggle to hold it still; beside the Head of People's own thread only the map draws. `?view=health` keeps the health page (`HealthPage.tsx`); it no longer embeds the conversation.

**Open proposals at the top.** One line above the thread says how many proposals wait and how many changes they hold, with the answers staged so far when there are any; the proposal the person came for is a breadcrumb on that line. The line opens to the rows (`OpenProposalsStrip.tsx`, rows from `orgScreenModel.stripRows`), oldest first so they match the order of the cards in the thread: face, title, a short count ("64 records", "9 priorities") and the staged count; the full totals sentence and the age sit in the row's title. A row scrolls the thread to the message that draws the card (`findProposalCardMessage`: `op-N` alone on a line, by an agent), or to the proposal's time while that message is not loaded, and the list closes. A proposal written on another thread has no card here, so its row expands the card in place, capped and scrolling, under a composer bridge keyed to this conversation: its answers join this batch and the send passes `say`, so the author's thread is told. A `?proposal=` the rows do not hold draws one line: where it is (with Switch), or that it cannot be read.

**One card, in the conversation.** An `op-N` on its own line draws the proposal (`ProposalCard.tsx`, `ProposalLedger.tsx`): the letter's lead (Read the rest), one totals sentence from `proposalTotals` ("64 records: 42 done, 16 reopened, 4 abandoned, 1 dropped and 1 to the backlog", "9 project priorities", "4 changes: 1 session named as a role and 3 plans filed"), then the entries. A records proposal draws one collapsed row per record group (`RecordGroupRow.tsx`; the groups are the contract's `orgRecordGroups`, one ask each: by project, then plan, then every one-change plan close folded into "N plans", then the loose rest): the title, its totals line, and Approve, Reject and Reply; opened, it lists its rows by `#seq`, one plain sentence each, twenty at a time. Everything else draws one subject card per subject (S39, `ProposalSubjectCard.tsx`): the sentence, the fields that move with what was there and what replaces it, names with faces, the reasons. A charter edit draws each passage as an inline diff (removed struck on a red wash, added on a green wash, untouched sentences as a quiet gap), never two full texts; any text longer than two lines clamps with "show all"; a revision the author made draws the same field diff. Three type sizes in the card area. Hovering or focusing an entry lights its node on the map (`OrgHoverContext`); `?proposal=op-N&focus=n` scrolls to the card once the thread's jump has settled and marks the entry holding change `n` (`orgFocusChangeId`). An `op-N#seq` ref anywhere is a link to that.

**One way to answer, staged until the send.** Approve, Reject and Reply live only on the entries in the conversation. Pressing one applies nothing: the controls are replaced by a band (`StagedBand.tsx`), "Approved. Applies when you send." ("Rejected." and "Replied.": "Sent when you send."), with Undo, and the answer joins the conversation's batch (`reviewComments`, S39). The tray above the composer says what the batch does, "3 changes will apply when you send, and 2 answers go with them", and the send button reads "Send and apply 3" (or "Send 2 answers"); `batchSendWords` (`lib/reviewActions.ts`) is the one place that counting lives. One send carries the answers and the typed words in one message (`orgProposals.reply`); the cards then read the server's stamps (Approved, applying; Applied; Rejected; Failed with Retry). "Approve the rest" at the card's foot stages every entry that still waits. There is no Send on a card, no reply box, no Edit, no panel, and no strip of buttons on the map.

**One translator.** `packages/shared/contracts/orgChangeWords.ts` is the one way a change becomes words: `changeWords(change, ctx)` gives the sentence (the brief clause set of `orgProposal.ts`, capitalised), the terse line the journal and the CLI print, the chip the map draws, and the fields with before, after and a passage diff; `subjectWords` joins a subject's changes into one sentence, `fieldMoves` says what an amend moved, `proposalTotals` writes the totals sentence. The web adds only what it alone knows: the live record a waiting card compares against, and faces (`proposalSubjects.ts`). `staffingModel.changeFields`, `staffingRevise.amendedMoves`, `proposalSubjects.rowsFor` and `orgMeta.chipLine`'s body went into it.

**What was deleted.** The staffing pane and the scope panel, the proposal thread embed with its `since` cut, every `ProposalReplyBox`, the `/company` proposal cards, the ghost answer strips and Edit on chart nodes, the chart pane (`/org?view=chart`), the single-change card, accept-with-edits on the web, the `decide`, `acceptAll` and `decideAsk` store actions (the server mutations stay for the CLI routes), and the org tours that pointed at those surfaces.

## S42. One screen for the company

Written 2026-10-07. This section supersedes the split of S41 (a conversation beside a map, with goals, projects, people and the health page each on a page of their own) and S40's reach (the map as the only picture of the company on the screen). S41 still holds for how a proposal is drawn and answered: one card, in the conversation, staged until the send. S40 still holds for how the map draws. The build spec this came from is the "company in one screen" spec (D1 to D18).

**Why.** The founder thinks about one thing, the company: what it is for, what it is trying to move, which work moves it, and who (a person or an agent) answers for each piece. Before this, those facts were spread over `/org`, `/goals`, `/projects`, an unrouted `/company`, `/org?view=health`, `/org/or-N`, `/team` and `/team/:username`, each laying out the same seven facts in its own order, most of them linking nowhere.

**Two panes and one seam.** `/org` is `OrgScreen` (`components/org/OrgPage.tsx`). On the left is the conversation with whoever answers for what is being read; on the right is the company (`components/org/company/CompanyPane.tsx`). Between them is one resizable seam (`ConversationWithPanel` on react-resizable-panels), stored per person under one layout key, `clientState.layouts.org`, so the split stays where the person put it as they move between objects. Double-click resets it to half and half. Under 980px the panes stack behind a Conversation | Company switch, and the thread never remounts across that line.

**The left pane.** Arriving by address at `/org/<ref>` puts that object's responsible party on the left: a goal's owner seat, a project's lead, the role itself, or the Head of People. Opening a sheet inside the screen never swaps it; "Talk to X" on a sheet and a double-click on a role on the map swap on purpose. The head says who you are talking to, with "Back to Head of People" when it is someone else. Above it, the needs-you strip (`OpenProposalsStrip.tsx`, `needsYou` in `staffingModel.ts`) is the one count of what waits on the person: proposals, decisions and stuck roles, the same number the sidebar's Org row shows. Picking a proposal there returns the left pane to the Head of People and scrolls to its card.

**The right pane.** `Read | Map`, kept per person in `clientState.ui.org_view`, then one filter row both lenses share: Everything, Goals, Projects, People (`?lens=`). Read is the company as a document (`components/company/CompanyDocument.tsx`): one state line, the goals, the projects no goal carries, then people and roles, each a line from `components/org/lines/` on one column grid, with goals expanded in place (`clientState.ui.org_expanded`). Map is S40's map. Its corner holds As proposed, Following beside a thread, and on People, This week.

**Sheets.** Every goal, project, role and person opens as a sheet over the right pane (`SheetFrame`, `sheets/{Goal,Project,Role,Person}Sheet.tsx`), 400 to 560px from the right edge, leaving at least 260px of the lens visible beside it, where the map rings the object and the document stays live. On a narrower pane the sheet covers the lens, which stays mounted underneath. The address holds only the top sheet; a back step appears when the in-screen stack holds more than one, and Esc steps back, then closes. Every sheet uses the same order: the crumb (the object's place in the company tree), the head line (owner, state, measure, date, in that order), **Serves**, an Ask box into the owner's standing session (Message on a person), then the kind's own sections with **Now** (live sessions, what waits on the person, and one violet line per open proposal change touching the object, which scrolls to its card) and **Carried by**, and the record and activity folded at the foot. A sheet has no Approve button: proposals are answered only in the thread.

**Creating.** One New menu in the header: Goal and Project write an optimistic stub and open its sheet with the title focused; Role opens the hire dialog. The only other create is "+ Project" in a goal sheet's Carried by.

**One address per object.** `objectHref` (`packages/shared/entities`) sends a goal (`in-N`), a project (`pj-…`), a role (`or-N`) and a person (`@username`) to `/org/<ref>`; inside the screen a pill opens the sheet instead. `/goals`, `/projects`, `/company`, `/team`, `/roadmap` and `/initiatives` redirect into `/org` with the matching filter. `/projects/<pj-…>` stays the work board, and `/team/:username` stays the activity profile, linked from the person sheet.

**The gate.** The team feature `org` gates only the left pane. With it off, `/org` is the company alone: the document, the map and the sheets, with no conversation and no seam. Goals, projects and people do not need agents.

**This week.** The health page (S29) is folded into the screen; its three parts each have a better home.
- The picture: on the map's People filter, the corner's **This week** toggle (`?week=1`) draws each role card as its week (work that reached it against work it closed, day by day, and the signals that need a person) and the reporting lines as the work flowing down them, with handoffs between roles drawn across the tree (`OrgGraph`'s `flow` mode, numbers from `orgFlow.ts`). The open role sheet's lines stay lit. A health read that failed is said in the map's corner, never drawn as a quiet company. Leaving People or choosing Read drops the week from the address, and an address that asks for it shows the map.
- A role's week: the role sheet's **This week** section shows the same card (`RoleWeekBody`), its fix loop, and behind **What if** its two levers (`RoleLevers`, `healthParts.tsx`): its daily limit replayed over the week and set in place, and part of its work handed to another role, asked of the Head of People.
- The controls: pause, resume and run now live on the role's Triggers tab, and its daily limits in its Settings tab.
- `/org?view=health` redirects to `/org?lens=people&week=1` (`healthRedirect`, `orgScreenModel.ts`). The header's menu reaches the same address as This week.

**What was deleted.** The goal list and the goal page (`InitiativesList`, `InitiativePage`, `/initiatives`), the projects list with its inline create, the `/company` page (its document is the Read lens), the Team Directory, the roadmap page, the role page's glance header (`ScopeGlance`), the sidebar's Goals and Projects rows and Org under Agents, the palette's Goals, Company document and Team Directory rows, the six parallel href builders, the health page (`HealthPage`) and its board (`HealthBoard`): its waiting row is the needs-you strip, its role drawer is the role sheet, and its levers are `RoleLevers`.

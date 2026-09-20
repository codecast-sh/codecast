# Roles that run their part of the company (W7)

Written 2026-09-18 from the founder's five asks after the S19 page landed:
roles triage the sessions in their scope and decide what reaches a person;
the analyzer names the long running sessions that already are roles; a role's
scope is one hover away and the first thing its page shows beside the
conversation; projects show their lead; roles are assignees on the task
board, and a person can see everything in their reporting chain. Builds on
org-roles-standing.md (W1), org-staffing.md (S9, S16, S19),
scopes-and-feed.md (F4) and session-characters.md (S4, S5).

The principle under all five: a role is a colleague, not a filter. It has a
face, a name, an area, a boss, sessions that report to it and tasks it owns.
Everywhere the product shows a person, it can show a role in the same place
with the same gestures, and the person above the role sees its work rolled up
under their own.

## R1. A role's sessions are the role's to triage

**Where a session sits.** A session that reports to a role
(`conversations.org_role_id`) is that role's. In its host's inbox it renders
as a nested row under the role's card, the row a subagent already uses, and it
does not count toward the host's needs input. The role's card carries the
role's own state and one number: how many of its sessions it has put in front
of the person. Opening the role's card shows its sessions grouped by who acts
next, the same grouping the scope page's Sessions tab uses (F4.3).

**Escalation is the role's verb.** `cast escalate <session> "<one line>"`
puts one of its sessions in front of the person: the session becomes a first
class card in the host's needs input with the role's face and line on it
("@growth: the pricing copy is ready and needs your eye"). `cast escalate
--clear <session>` takes it back under the role. A person has the same two
gestures on the row (Put in my inbox, Hand back to @growth). A role may
escalate at any trust level; answering a session's question itself needs the
decide or direct trust it already has, inside its grants (W2 D4). Escalation
writes `conversations.escalated_by_role: { role_id, line, at }`; the inbox
classifies on it; clearing removes it.

**Taking over a scope takes over its sessions.** When a role gains scope (a
role change with projects, a scope change, an adopt, or a person's edit in
Settings), the sessions in that scope that report to the host and to no role
are re-homed to the role in the same apply, through the one reparent core
(`sessionOwnership.performReparentSession`, S11). The change's note says so
before it is accepted ("12 sessions now report to @growth and leave your
needs input") and the row offers the one edit that matters: leave the
sessions where they are. The apply's told counts say what happened
afterwards. A session with an open escalation to the person keeps it.

**What the role does with them.** The standing prompt carries the principle:
the role reads which of its sessions are waiting on a person every time it
wakes, answers what it may, and escalates the rest with one line each that
says what the person will decide. A session waiting on a person for more
than a day without an escalation is a stall the role's health flags (S2
counts it as an open stall). The role never escalates silently: a session
it puts in front of a person carries its reason.

**Wake frame.** The frame's "Hands say" section (T3) becomes "Your sessions"
and lists, per session waiting on a person, its title, its one line state
and how long it has waited; the role acts on that list.

**As shipped (2026-09-18).** The field is `conversations.escalated_by_role`;
its one writer is `sessionOwnership.performEscalateSession` (the
`escalateSession` mutation, route `/cli/sessions/escalate`, verb `cast
escalate`). A hand cannot escalate itself: it is told to tell its role. A
person's own gesture needs no line and is stored as theirs. A reparent to a
person, or to another role, drops the escalation with the pointer. The
takeover is `sessionOwnership.performRehomeSessions`, called by
`orgInit.takeOverSessions`. A live role gains scope in exactly one place, the
role update (`orgRoles.performUpdateRole`), so the takeover and the person's
one edit live there and every door inherits them: the scope editor in Settings
and on the chart's panel (`orgRoles.update`), `cast role scope`
(`orgRoles.setScope`), a project's lead and an initiative's owner
(`performCoverProjects`), and a move or scope change (`applyMove`). A new role
takes over after its seat exists: `applyRole` and `applyAdopt` for a proposal,
`performHireRole` for a hire from the form or `cast role create`. Only a change
that ADDS scope takes over, a role that looks after the whole workspace takes
over nothing, and one apply moves at most 100 sessions and counts the rest in
its note. "An open escalation to the person"
is a decision pending on the session at the takeover: that session moves and
stays in front of the person with a line that says why. The person's one edit
is `leave_sessions`: on a role, scope, move or adopt change (an edit on the
row, or on an ask accepted whole through `orgProposals.decideAsk`), and as an
argument of `orgRoles.update`, `setScope`, `setProjectLead` and `create`
(`--leave-sessions` on `cast role scope` and `cast role create`).
`orgInit.takeoverPreview` is the dry count before accept. It takes every row a
page shows in one call and scans the workspace's sessions once for all of
them; `contracts/orgProposal.orgChangeTakeover` says which changes take over
and what to ask, and `takeoverPhrase` there writes the sentence before and
after. On the web the count and the edit are one component
(`components/org/TakeoverEdit`): on the proposal's asks and rows, in the hire
form, and at the gate (`TakeoverGate`) that a scope gain made by hand waits
at, which confirms itself when nothing would move.

The read budget, measured 2026-09-20 on a scope of 860 tasks filed by others
and 440 sessions: the dry count is 114 reads and the apply 817, from 973 and
2,573. `org.resolveScope` reads the caller's keys once for all rows
(`lib/access.accessJudgeFor`), a takeover resolves its role, its admin check,
its acting person and its sender once for the batch
(`sessionOwnership.prepareReparentBatch`), and a reparent with no open
question skips the ladder walk. Accept all cuts its chunks by cost
(`orgProposals.acceptAllChunk`): a change that takes over is the last of its
transaction, so one transaction holds at most one. The scope summary reads
open decisions once per member, never once per task. The stall is `session_wait_hours` in
`orgCapacity.ts`, counted into `open_stalls` by `orgHealth`. The principle is
the "Your sessions are yours to triage" bullet of `anchors.bootstrapMessage`
and rule 6 of `ROLE_RULES`; its dry run (4 of 4 samples escalate the brand
call with a reason and answer the charter question themselves; 0 of 4 escalate
with the bullet cut) is in `/tmp/r1dry`.

Two limits, decided 2026-09-18. The hand refusal on `cast escalate` is the
T4 limit (org-roles-standing.md): a hand runs under its host's token, so a
hand that strips its session variables passes as the person; the refusal
keeps an honest hand from escalating itself and is not a boundary. And a
reparent to a person clears the row's stash, because the new owner has never
seen the session and it must appear in their inbox, while a reparent to a role
keeps it, because the role triages and the row nests under it without needing
anyone's eyes (`sessionOwnership.performReparentSession`, both cases pinned
in orgRoles.test.ts).

## R2. A long running session is a role that has not been named

The analyzer's grounding (S9) reads sessions for who commits where. It also
recognises the sessions that already behave as roles: a session older than a
week with a standing purpose, read from its pinned state, its triggers, the
subagents it has started (a session with hundreds of them is a manager, not a
task), the projects its tasks bind to and the repositories it commits to.
Such a session is proposed as a role with `seat: { existing: <session> }`
(S16), so accepting names it rather than replacing it: the session becomes
the role's standing session with its history intact, its subagents become
its sessions, its scope is the projects it touched, its name comes from the
session's title, its charter is drafted from its pinned state and first
message, and it gets a face. The proposal's role card says "this is Market
growth mandate, which has run for 34 days with 391 helper sessions; naming
it changes nothing about how it works and gives it a place on the chart".

The analyzer says which sessions it considered and did not propose, in a
finding, so a person can name one the analyzer left out. A person can also
do this from the session itself: the ownership menu (S11) offers "Make this a
role" on a session that fits.

## R3. A role's scope at a glance

**Hover.** The role hover card (session-characters.md S4) attaches everywhere
a role is named, with no exceptions: the chart node, the inbox card, a chip in
prose, a task's assignee, a project's lead, the proposal author, the wake
card, the ownership menu, the scope overview of another role. Its scope
section renders each project and plan by name with its state ("Platform · 14
open tasks · lead"), the sessions by who acts next, the charter's first
sentence, who it reports to, and today's use in the pane's words (daily
limit, not caps). Click anywhere on the card opens the role.

**The role page.** The right rail's first tab is Scope, and it opens on it:
what the role looks after (projects with their state and lead, plans with
progress), the sessions grouped by who acts next with the escalated ones
first, the charter's first paragraph with the way to the whole charter, who
it reports to and who reports to it (roles under it), the tasks it owns by
status, and the daily limit in plain words. Feed, Tasks, Line, Plans, Docs,
Sessions, Decisions, Brief, Charter, Wakes and Settings follow. The Scope tab
is the same rendering the hover card uses at its full size, built once
(`RoleScopeView`, two densities).

## R4. Projects show their lead

`projects.owner_role_id` is the lead. It renders with the role's face and
name, and the hover card, on: the project page header, the project list (the
chip is there), the scope overview of the lead and of any role whose scope
includes the project, the chart node's scope chips, and the task board's
project group header. A project with no lead shows "no lead" with the one
gesture Add a lead (F1), which opens the hire dialog with the project filled
in.

**One rule for who leads.** A project's lead is `owner_role_id`. A role whose
scope includes a project is its lead only when the project names no other;
when two roles' scopes include a project and the project names neither, the
project shows "two roles watch this" with both faces and the analyzer's next
review proposes the owner. Setting the lead from the project page writes
`owner_role_id` and, when the role's scope does not include the project,
adds it (one action, one intent, the person told both things).

## R5. Roles are assignees

**A role can own a task.** `tasks.assignee` accepts a role's id beside a
user's. `resolveAssigneeInfo` (lib/liveEntities) resolves a role to its face,
name and handle from the org tree slice, so every surface that shows an
assignee shows a role the same way it shows a person, hover card included.
Filters and pickers list roles with people, grouped under "Roles" and
"People".

**A session that takes a task assigns it to its role.** `cast task start`
from a session that reports to a role assigns the task to the role (the
session stays bound to it as today), unless the task already names a person.
`cast task start` from a role's standing session does the same. A person
assigning a task to a role wakes the role (a fold row, T3) with the task in
the frame.

**Taking over, not creating.** The founder's words were "if an agent is
taking over tasks it should assign it to themselves". So `cast task start`
hands the task to the role only when the session is taking work over: the
task was not filed by that same session, and it is not a subtask. A task a
session files for its own bookkeeping and then starts stays unassigned and
internal as it is today, because any assignee puts a task on the person's
default board (the rule below). A subtask stays nested under its parent with
no assignee of its own; the parent says who answers for the work. A role's
standing session follows the same rule, and another session of the role that
later takes that task over does assign it. The rule lives in the one place
`task start` decides the assignee (`tasks.ts` `roleTakingTask`).

**A handle names someone or is refused.** `--assignee @growth` resolves a
teammate with that exact handle first, as chat does, then the live role with
that handle in the task's workspace. A handle nobody answers to, a retired
role and a role from another workspace are refused with a sentence that says
why; none is stored as a bare string no roster or chart could resolve.

**Group by assignee, and by chain.** The task board's assignee axis groups
roles and people as peers, each group headed by its face and name. A new axis,
Chain, groups by the person at the top of the reporting chain: a person's
group holds their own tasks and, nested, one group per role that reports to
them (and roles under those), so a founder sees everything in their chain
and a lead sees theirs. `cast task ls --assignee @growth` and `cast task ls
--chain me` are the CLI forms. The chain is read from the org tree
(`reports_to`), never stored on the task.

**A role's tasks are the company's work, so the board shows them.** The
default board hides a task an agent filed for itself, because that is one
session's bookkeeping. A task a role holds is not that: whatever created it,
it shows on the default board, under the role on the Assignee and Chain axes,
with no change of Source. This is the existing board rule and not a new one:
`isOnHumanBoard` (`@codecast/shared/tasks`, read by web and mobile) puts any
task with an assignee on the board, and a role is an assignee. An agent filed
task with no assignee stays hidden as today. Ledger tasks (W8, type `ledger`)
stay off the board whoever holds them; that exclusion is W8's to write, in
the same predicate. `cast task ls` applies no board filter, so `--chain me`
already lists the same tasks the Chain axis shows.

**As built (review fixes, 2026-09-20).** One resolver,
`tasks.resolveAssigneeStr`, serves every assignee write and every list
filter. A handle is matched the way chat matches it (`lib/mentionResolve`
`matchHandle`): a teammate's login or email, never a display name; a bot on
the roster is never a person, so a role outranks the bot user its seat renders
as, and that bot user's own id names the role too. Who may take a task is its
ACCESS key (`tasks.boundaryOfTask`, read from `workspace`, never `team_id`):
a task readable by its owner only is refused to a team role in words that say
why, the task list judges each row with the access layer's own evaluators,
and a guard test pins both. A read (`--assignee`, `--chain`) names what a
task holds, so a retired role's tasks can still be listed by its id or
handle. Retiring a role hands its open tasks to whoever it reported to
(`tasks.handOpenTasksUpChain`, told as any assignment is); a retired role
stays in the chain it reported to (`contracts/orgAssignee` `chainParentOf`,
the one parent step the server, the board's Chain axis and its filter walk),
so whatever it still holds is read under the same person. A hand's second
`task start` reaches the role whether or not the session is still bound to
its first task. A fork of the session that filed a task starts it as that
session's own bookkeeping. The CLI's task verbs (start, done, handoff,
verdict, drop) send the caller's own session id or none, never a guess at
the one transcript recently active, because the server reads the session's
role off that id. Pickers list people and roles from one source
(`lib/assigneeOptions`), and who is a person is `is_bot` on the roster row,
so a cold deep link needs no org tree to get it right.

## The test

A person who has never seen the feature opens their inbox and sees fewer
cards than yesterday, each remaining one either theirs or carrying a role's
face and one line saying why it is in front of them. They hover a role
anywhere and know in three seconds what it looks after. They open a project
and see who leads it. They open the task board, group by chain, and see their
whole company's work under the people who answer to them.

## R6. A person who reports to a role

From the team huddle of 2026-09-18. Two people asked to report to an agent and
said what they meant by it: one place that keeps their three to five high
level goals, tracks all of their sessions against those goals, and keeps them
making forward progress; an agent that is "on top of me to make sure I am
doing high priority stuff and not dropping the ball". Not permission to do
things. So a role a person reports to is a goal tracker first.

**Goals live in the role's brief, one section per person.** When a person
reports to a role, the role keeps that person's goals (three to five, in the
person's own words, set in the conversation: "my goals this month are...")
in its brief under the person's name, with the sessions, tasks and plans it
has matched to each goal. A goal with nothing matched to it for a week is a
finding. Editing the goals is the same gesture as R4's remember: say it to
the role, or edit the Brief tab.

**Every wake, the role reads the person's sessions against the goals.** The
frame's "Your sessions" section (R1) includes, for each person who reports
to the role, their sessions that changed since the last wake, and the role
matches them to goals in its own words. It never reads a private session it
cannot open.

**Where the person reads it.** The person's own view of a role they report
to is the role's page, whose Scope tab (R3) shows, for that person, their
goals with what moved on each and what stalled. The role's weekly note (its
routine) says the same in prose, and a stall on a high priority goal is a
fold wake to the person, one line, never more than one a day.

**Tasks a role holds are visible to the person above it.** From the same
call: a task leaving a person's list when a role takes it is "a little
scary". The safeguards are R5's rule that a role never reassigns a task that
names a person, the Chain axis that shows a role's tasks under the person it
reports to, and the goal section above, where a task matched to a goal is
reported on whether the role or the person holds it.

**As built.** Who reports is `org_roles.reports_user_ids`, set from the
role's Settings tab or `cast role reports @handle --add me`; a person adds or
removes themself, an admin of the role anyone in the workspace, and a new
report wakes the role at once so it asks for goals. Goals are text under
`## Goals: <name>` in the brief (parser: `contracts/roleGoals.ts`); the short
ids on a goal's line are its matches. `convex/orgGoals.ts` reads those rows
with the viewer's grants and gives the frame, `org.brief`, the Scope tab, the
Brief tab and the health query one answer. A goal stalls after
`goal_stall_days` with nothing matched to it moving, and is a finding after
`goal_unmatched_days` with nothing matched at all. The age of a goal with no
match counts from when the hourly sweep first saw it
(`org_roles.goal_first_seen`), never from the brief's edit time, because a
role rewrites its brief at every wake. The notice is the `goal_stall`
notification, once per person per UTC day (`org_roles.goal_notices`). The
prompt is one principle in `anchors.bootstrapMessage` and rule 7 of the
charter; the dry run and its ablation are recorded on ct-52526 (four of four
samples wrote the matches back with the principle, none of four without).

## R7. What an assignee means

From the same call: a session refused to ship a task because the task was
assigned to someone else, and nothing in its instructions said to. The model
inferred a permission boundary from the assignee field. Assignee means who is
accountable for the task, never who may act on it; any session may work a
task, and the assignee is who answers for it being done. The task context
the CLI prints (`cast task context`, `cast task start`, the bound task line
in the system text) says so in one sentence, so no model guesses the
stricter reading. This matters more once roles hold tasks (R5).

**As built.** `ASSIGNEE_MEANS` (`contracts/orgAssignee.ts`) is the sentence,
printed by `cast task start`, by `cast task context` beside the assignee, and
in the tasks snippet. The role page's Settings tab says where the seat runs:
the host, the machine of the standing session (`devices.getConversationMachine`)
and the model. When the standing session is parked on a usage limit, the same
section says what codecast does on that machine, in the sentence `cast usage`
prints (`describeLimitRecovery` in `contracts/usageLimits.ts`, one body for
both), and what a person can do: move the session to another machine from its
header chip, or add an account with `cast accounts save <name>`.

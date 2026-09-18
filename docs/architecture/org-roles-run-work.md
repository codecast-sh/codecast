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

**Group by assignee, and by chain.** The task board's assignee axis groups
roles and people as peers, each group headed by its face and name. A new axis,
Chain, groups by the person at the top of the reporting chain: a person's
group holds their own tasks and, nested, one group per role that reports to
them (and roles under those), so a founder sees everything in their chain
and a lead sees theirs. `cast task ls --assignee @growth` and `cast task ls
--chain me` are the CLI forms. The chain is read from the org tree
(`reports_to`), never stored on the task.

## The test

A person who has never seen the feature opens their inbox and sees fewer
cards than yesterday, each remaining one either theirs or carrying a role's
face and one line saying why it is in front of them. They hover a role
anywhere and know in three seconds what it looks after. They open a project
and see who leads it. They open the task board, group by chain, and see their
whole company's work under the people who answer to them.

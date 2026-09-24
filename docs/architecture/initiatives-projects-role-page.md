# Initiatives, projects, and the role page as the session page (W9)

Written 2026-09-18 from the founder's three directions after W7 started:
opening a role's session from anywhere shows the role page; projects are the
top level unit of a scope and every piece of work has a lead; and initiatives
are added above projects to describe and drive the company's goals, in the
spirit of Linear's initiatives. Builds on scopes-and-feed.md (F4),
org-staffing.md (S7, S9, S19), org-roles-run-work.md (R3, R4, R5, R6).

The order of things, top to bottom: an initiative is a goal the company is
trying to reach; a project is a body of work that contributes to it; plans
and tasks are inside projects; roles lead projects and own initiatives;
sessions do the work. Every page in the product shows its place in that
order, and the analyzer reads it from the top.

## I1. Initiatives

**What one is.** An initiative is an intentional set of projects tied to a
shared objective, with one owner who drives it. It is not a filter; projects
are added to it on purpose. Linear's definitions are adopted where they fit
and the wording is kept where it is already the plainest: status is
Proposed, Planned, Active, Completed or Cancelled; health is on track, at
risk or off track, read from the latest update; the description carries
purpose, scope and context.

**Table.** `initiatives`: `short_id` ("in-N"), `title`, `description`,
`status`, `owner` (`{ kind: "user", user_id } | { kind: "role", role_id }`,
because roles are colleagues, R5), `target_date?`, `priority?`, `labels?`,
`project_ids` (ordered), `parent_initiative_id?` (one level of nesting),
`health` (denormalised from the latest update, `none` before one exists),
`latest_update_id?`, `workspace` (the access key), `team_id` (routing),
`created_by`, timestamps. `initiative_updates`: `initiative_id`, `body`,
`health`, `by` (a user or a role's standing session), `at`. A project may
belong to several initiatives; the initiative page lists what it shares.

**Progress and health roll up from the projects.** Progress is tasks done
over tasks in the initiative's projects, derived at render from the store
(never stored). Each project shows its own state and lead (R4) inside the
initiative. Health is whatever the owner said last, with the date; a project
whose lead has flagged trouble in its charter or whose plan slipped past its
target shows that beside the owner's word so the two can disagree visibly.

**The page.** `/initiatives` lists them by status with owner, health, target
and progress. `/initiatives/in-N` opens the way a scope opens (F4): the
conversation with the owner on the left when the owner is a role (and the
owner person's anchor when it is a person), and the initiative on the right:
the description, then the projects each with lead, status, open and done
counts, plans with progress, and the sessions active in them, then the
updates newest first with their health, then sub initiatives. Update is one
control: it opens a short form (body, health) and writes an update; a role
writes one from its routine with `cast initiative update in-N --health
on_track - <<'EOF'`. Health is what the owner said, so only the owner posts
an update (a person, or the owning role's standing session), and a workspace
admin may post one for them; everyone else reads. The target is a calendar
day, stored and read through one shared pair (`shared/time` `targetDayStamp`
and `targetDayOf`) so the CLI and the picker name the same day in every
timezone. The header carries title, status, owner (with the hover card),
health and target.

**Everywhere else.** `in-N` renders as a live pill wherever short ids do. A
project page shows the initiatives it belongs to under its lead. A role's
scope view (R3) lists the initiatives its projects contribute to, and the
initiatives it owns first. The task board gets an Initiative axis (through
the task's project), and `cast task ls --initiative in-N`. The chief of
staff's weekly review reads initiatives as the top of the tree: its letter
opens with how each active initiative is doing before it says anything about
records. The CLI: `cast initiative create "Title" -d - [--owner @role|me]
[--target 2026-12-01] [--project <id>...]`, `ls`, `show`, `update`,
`add-project`, `remove-project`, `set --status|--owner|--target`.

**The org.** An initiative's owner role has every project of the initiative
in its scope, added when the owner is set (one action, one intent, the
person told). The analyzer's coverage rule (I2) applies from the initiative
down: every active initiative has an owner, every project in it has a lead,
and an initiative with no owner is the first finding in a review. The org
chart groups nothing by initiative; the role card's hover names the
initiatives the role owns.

As shipped (2026-09-18): the owner's scope is `performCoverProjects`
(convex/orgRoles.ts), the scope half of `performSetProjectLead` extracted so
both go through one write: one role update for every project added, one
session takeover, `not_admin` reported and never thrown, safe to repeat;
convex/initiatives.ts calls it wherever the owner becomes a role. The
analyzer reads the top of the tree from `coverage` in `org.analysisInputs`
(convex/lib/orgCoverage.ts, pure, beside lib/orgActivity): the open
initiatives with owner, health, date and projects with leads. The prompt rule
is `ORG_INITIATIVES_RULE` (packages/cli/src/orgInit.ts), and the letter's
second paragraph is written into the letter's own shape sentence and the
decision rule, at their sites. An initiative with no owner is a finding that
names who to ask; the analyzer posts no change for it and never creates an
initiative. The scope view's list is `roleInitiatives`
(packages/web/lib/roleInitiatives.ts), mounted through lib/roleScope.

## I2. Projects are the unit of scope, and every piece of work has a lead

**In the scope view.** A role's scope (R3) renders projects as its first
section, one card each: the project's name and status, its lead, the
initiative it belongs to, open and done tasks, the plans inside it with
their progress, and the sessions active in it by who acts next. Plans and
tasks appear inside their project, never as a flat list beside it. A scope
that names plans outside any project shows them in a last card, "not in a
project", with the one gesture that files them.

**Coverage.** The analyzer (S9) reads every project with work planned or in
progress, every plan, and every session and commit of the last thirty days,
and proposes leads until all of it is covered: a role for each uncovered
project, wrapping the project that exists rather than inventing a new area;
a new project for work that happens outside any project (sessions and
commits with no project, plans with none), then a lead for it. It aims at
about one role per project and departs from that only with a reason it
states: two small adjacent projects sharing a lead, one large project split
by its plans. The letter's coverage line says the before and after in
counts ("9 of 12 projects had a lead; after, 12 of 12, and 2 new projects
hold work that had none"). The /cast-org skill states the same default.

As shipped (2026-09-18): `coverage` lists every active project with work (an
open task or an open plan, health's own rule) with its lead by
`projectLeadOf`, so a whole workspace role hides no gap, and the work outside
any project: open plans with none, loose open tasks, and areas of commits and
sessions that tie to no project. The glance and `cast org inputs` print the
before count from one function (`coverageLine`). The rule is
`ORG_COVERAGE_RULE`: wrap the project that exists; a project first and then a
lead for work outside one; about one role per project with the departure's
reason in the change; coverage counted after the records are in line; leads
that are alike are one ask. No new change kind was needed.

## I3. The role page is the session page

**Opening a seat opens the role page.** A role's standing session, opened
from anywhere (an inbox card, the chart, a pill in prose, a shared link, the
command palette), renders as the role page: the conversation on the left,
the scope on the right (R3). `/conversation/<id>` for a standing session
renders that layout in place; it does not redirect, so the URL a person
shares still opens what they saw. A hand is a session and keeps the session
page; only seats change.

**The session's actions stay.** The conversation header on the role page
carries what the session header carries today (owners, device, share, diff,
transcript, kill and the rest) in a compact header that expands on demand,
so nothing a person could do on the session page is lost. A "Session view"
control in that header opens the plain conversation view for the person who
wants the old shape; it is a view, not a setting, and the next open is the
role page again.

**The test.** A person clicks a role anywhere and lands on the same page
every time: the role talking on the left, what it looks after on the right,
with projects first and every project showing its lead and its initiative.
They open an initiative and can say what the company is trying to reach,
who drives it, how it is going and which projects carry it, without opening
anything else.

## I1, revised: the reviewer proposes goals

Written 2026-09-23 from the founder's direction: the reviewer reads the
company's initiatives and until now could only report on them. It now
proposes them, the way it proposes every other change, and a person accepts.

**When.** The reviewer proposes an initiative when the evidence shows one
shared goal: the projects' own goals point at it, or a call or a chat thread
names it. It proposes a project into an existing initiative when that
project's work serves the initiative and the initiative does not list it.
It proposes an owner when an active initiative has none, naming the person
or the role that already drives that work. It still applies nothing: each is
a change on a proposal, and nothing exists until a person accepts it.

**Three change kinds** (`shared/contracts/orgProposal.ts`):

- `initiative`: `{ title, description, projects: [ref], owner?: "@handle" |
  "me" | a member's name, target_date?: unix ms }`. The description is the
  sentence that says what reaching the goal looks like. Accepting creates the
  initiative through `performCreateInitiative` (convex/initiatives.ts), the
  same core `cast initiative create` and the page use, in `proposed` status
  with its projects and its owner; an owner role gains the projects in its
  scope the way it does on the page (`performCoverProjects`).
- `initiative_projects`: `{ initiative: ref, projects: [ref], title? }`.
  Accepting adds the projects through `performAddProjects`, the core behind
  `cast initiative add-project` and the page's add.
- `initiative_owner`: `{ initiative: ref, owner, title? }`. Accepting sets
  the owner through `performUpdateInitiative`, the core behind `cast
  initiative set --owner` and the page's owner chip.

Each is one change in an ask, worded for a person who has not read the
letter: "Set a goal: Win the private network, carried by Callers and Broker
network, owned by @calling"; "Add Callers to the goal Win the private
network"; "Make @calling the owner of the goal Win the private network". The
page lists the projects under the row and shows the owner as a role's face or
a person's face. `deriveAsks` puts every goal change of a proposal in one
ask, the goals ask, after the records and before the seats. Every writer of
these rows is the initiatives module's own: the proposal apply path never
inserts or patches an initiative itself.

**The way back.** Accepting logs one row per change (org-staffing.md S21):
`initiative` with `status` from nothing to `proposed` and the owner and
projects it set; `initiative_projects` with the project list before and
after; `initiative_owner` with the owner before and after. Undo cancels a
created initiative (the row stays, as a tombstone in `cancelled`, the way an
undone project create stays `done`), removes the projects that were added,
puts the owner back and takes back the scope an owner role gained. The S21
round trip table test (convex/orgChanges.test.ts, "S21: every change kind
round trips") carries the three kinds, so the suite fails until each round
trips. The initiative page reads its own creation row from the log and says
"Proposed by the review on <date>" for an initiative an accepted change made.

**The prompt.** `ORG_INITIATIVES_RULE` states the principle: propose an
initiative when the evidence shows one shared goal, an owner when an active
initiative has none, both as changes, and apply nothing. The letter's goals
paragraph is unchanged.

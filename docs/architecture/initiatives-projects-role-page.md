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
the task's project), and `cast task ls --initiative in-N`. The head of
people's weekly review reads initiatives as the top of the tree: its letter
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

## I4. The goal tree: parents, metrics, and the chain every role sees

Written 2026-10-02 from the founder's four directions: initiatives are the
goal tree the org plans against; each carries one or two numbers; everything
feeds up to the top level goals and every role is told how; and the review
reads what was said on calls, summarised or not.

**The tree.** An initiative's `parent_initiative_id` (I1, one level) is the
top level goal it feeds. The review proposes the tree: the `initiative`
change gains `parent` (a ref, or the title of a goal set earlier in the same
proposal; parents are listed before their children, since the apply order
keeps the proposal's order within a kind) and `metrics`; a fourth goal kind,
`initiative_shape: { initiative, parent?: ref | null, metrics?, title? }`,
places a goal that exists in the tree and says how it is measured. Both
apply through `performUpdateInitiative` and log as `initiative_shape` (its
own inverse: the parent and the metrics restore as fields; the S21 round
trip table carries it). `cast initiative create|set --parent` and
`--metric "Name=target"` are the shell.

**The numbers.** `initiatives.metrics` holds at most two
`{ key, name, target }` (`INITIATIVE_METRICS_MAX`, the key a slug of the
name, `metricKeyOf`). The values live in `initiatives.scoreboard` under the
key, the template scoreboard's own shape, and are written by the one
reporting path `cast org template report` uses: `recordScores`
(shared/contracts/orgTemplateState) takes any declaring set of keys, so
`cast initiative report in-N key=value --source <href> [--observed-at]`
(`initiatives.report`, `/cli/initiatives/report`) refuses an undeclared key,
an empty value and a source nobody can open the same way. Who may report is
who may post an update: the owner, the owning role's standing session, or a
workspace admin. A reported number is not an org change and writes no log
row.

**Read against the target.** `metricReading` (shared/contracts/initiative)
reads a value against its target in the target's own direction ("1,000" is
reached; "under 5%" is stayed below) and answers `met`, `behind` or
`unknown`, with a progress fraction toward a reach target;
`initiativeStanding` folds a goal's readings into one word (behind if any is,
met only when every reported one is). `metricLine` is the sentence a role
and a person both read ("Weekly active teams: 412 of 1,000, behind (3 days
ago)"). The owner's `health` stays what they said; the standing is the
target's, and every surface shows them side by side so they can disagree
visibly: the initiative page's "Measured by" section (edit in place, the
report command printed until a value lands, the chain under it), `cast
initiative show` and `ls`, the health panel's area rows, and the review's
`coverage.initiatives` (`metrics`, `standing`, `chain`).

**The chain every role sees.** `lib/roleInitiatives.servedInitiatives` is
the one reading of what an area feeds: the open initiatives a role owns,
then the ones its projects carry, each with its readings and
`initiativeChain` (nearest parent first, up to the top). The role card in
every wake (`agentTasks.roleCardOf`, `RoleCard.initiatives`) carries them as
`Serves:` lines (`roleCardInitiativeLine`, written and read by the one frame
writer and reader in machineMessages), and the run block draws them under
the card. `org.health` puts the same reading on each area row
(`RoleArea.initiatives`), which the health panel draws as "Serves" under the
goals. The review prompt says the tree is what the company plans against,
that on track means against the target, that a number is proposed only
where a person or a charter named it, and that a role serving no goal, or a
goal no role carries, is a finding.

**What a call said.** The review read ended calls only through their
generated summary, so a huddle too short for one (`summary_status:
"skipped"`, under forty words) or one whose summary failed reached it as
silence. `readSaid` now reads such a call's own segments, bounded
(`ANALYSIS_CAPS.calls_without_summary` calls, `call_segments` rows each,
`call_lines` lines kept), joins one speaker's consecutive lines, keeps the
lines that decide or ask (the chat rules, `DECIDED_RE` and `ASKED_RE`) and
falls back to the first few when none does, as `lines` on the call beside
`summary_status`. A summarised call carries no lines, and the whole block
stays under the one `said_bytes` budget.

**The goals people stated** (2026-10-03, measured on Union against an answer
key read from every call transcript and the team's chat). The review could
not build the tree because it never saw the statements a tree is made of: a
summarised call reached it as its summary, which keeps decisions and drops
"our goal is $250 or less per introduction"; a busy channel's newest fifty
lines reached back days, not the weeks since someone posted the company's
goals as a list; an initiative reached it as a title, without the description
that carried its numbers; and the call cap counted the thirty huddles that
ended before words, so two weeks of real calls fell outside it. Three samples
on those inputs found 3 to 6 of 8 goals under three different tops. So:
`readStatedGoals` (query part `goals`, its own execution and its own
`goal_bytes` budget) reads every person written chat line of the window
(`goal_messages_per_channel`) and every speaker's turn of every readable
call's own transcript, keeps the ones that name a goal, a priority list, a
mission or a metric (`statesGoal`), cuts a long turn around those words
(`goalExcerpt`) and returns them as `said.goals`, written lines first, each
with `where` (the channel, or the call's short id that `cast call <id>
--transcript` opens). `said.calls` rows carry that `id` too.
`coverage.initiatives` rows carry `description`. `readableCalls` applies the
cap to calls in which something was said. The prompt names `said.goals` as
where goals come from, takes a list a person wrote as the tree's first
draft, says the top of the tree is what the company is for, that the tree
has two levels, that a goal with an initiative is reshaped and never
restated, and that a target the reviewer worked out is not a stated one.
The goal tree focus asks for the whole tree in one run.

## I5. The intent record: everything about a goal, in the fewest fields

Written 2026-10-04 from the founder's direction: a goal should hold all of
our intent and all of our progress, structured where a machine reads it and
written where a person does, and no more complex than that needs.

**The test.** Open one goal and answer, without opening anything else: what
are we trying to reach, why does it matter, how will we know it is done, who
drives it, what is the number now against its target and which way is it
moving, what is the next milestone and when, what is still undecided, what
was decided, and who said this and where.

**The fields.** Seven are added to the `initiatives` row (I1, I4), all
optional, all on the row, so every surface that reads a goal (the pages, the
chart's Goals lens, the document view, the review) reads the same thing from
the one synced collection:

| Field | Kind | What it holds |
| --- | --- | --- |
| `why` | written | Why it matters, in a paragraph. |
| `done_when` | written | What done looks like: the sentence a person checks the result against. |
| `milestones` | structured | An ordered list of `{ key, title, date?, done_at?, source? }`, at most 12. The next milestone is the first one not done, earliest date first. Reached ones stay, so the list is also the record of progress. |
| `score_history` | structured | Per metric key, every reported value oldest first, `{ value, observed_at, source }`, the newest 52 kept. `scoreboard` (I4) stays the latest value and is a copy written by the one reporting writer, the way `health` is a copy of the latest update: the writer reads the latest of the history back, so a report backfilled for an earlier day never rewinds the current number. A renamed metric keeps its value and its history under the key its new name reads as. |
| `questions` | written | Open questions: `{ key, text, at, by?, source?, answer?, answered_at? }`, at most 20. A question with an answer is closed and stays on the record. |
| `decisions` | written | Decisions taken: `{ key, text, at, by?, source? }`, at most 40, newest last. |
| `sources` | structured | Where the goal was stated: a list of sources, at most 20. |

`description` stays what it was: the goal in a few sentences, its scope and
context. Nothing else is added: progress is still derived from tasks, health
is still the owner's last word, standing is still the number read against its
target.

**A source** (`IntentSource`, shared/contracts/initiative) answers "who said
this and where": `{ kind, ref?, quote?, by?, at? }`. `kind` is `call`, `chat`,
`doc`, `session`, `task`, `plan`, `link` or `note`; `ref` is the object's own
address (a call id with an optional line, a chat message id, a doc id, a
session short id with an optional line, `ct-N`, `pl-N`, a URL); `quote` is the
words as said, kept short; `by` is who said it, a name or an `@handle`; `at`
is when. One parser reads a source the way people and the review write one
(`parseIntentSource`: `call:<id>#<line>`, `chat:<id>`, `doc:<id>`,
`jx7c6zk:142`, `ct-12`, a URL, and anything else as a `note` whose text is the
quote), and one function says where it opens (`intentSourceHref`, web lib/intentSources, since routes are the web's). A
codecast link or path to a session, a task, a plan, a doc or a call
(`https://codecast.sh/tasks/ct-12`, `/conversation/jx7abcd`) reads as that
object, by the one url reader (`parseEntityUrl`, shared/entities), so a pasted
link and the short id name the same source; any other URL is a `link`. A
source sent in its stored shape is held to the same address rules: a link is
an http or https URL and stays a link, a call line takes the shared form, a
note has no address. A milestone, a question and a decision each carry at most one source
of the same shape. `by` on a question or a decision is who asked or decided, a
name or an `@handle`, resolved to a face at render when it matches the roster.
When an add names nobody its maker signs it, by one rule on the server and the
web (`initiativeSignature`): the role whose standing session made the call,
else the person's `@handle` where the roster reads that handle back as them,
else their name.

**The trend.** `metricTrend(history, target)` reads a metric's history into
`up`, `down`, `flat` or `unknown` and a short series for a sparkline, and
says whether the direction is toward the target. Every metric display shows
now, target, the trend and the date of the last report from this one reading.

**Writers.** Every write goes through the initiatives module's cores (I1,
revised). `why` and `done_when` are fields of `performUpdateInitiative`. The
four lists are edited one entry at a time through `performRecordEntry`
(`initiatives.record`): add, edit, close (reach a milestone, answer a
question) and remove, each naming the entry by key, so two people editing one
goal never overwrite each other's list with a stale copy. `score_history` is
written only by `performReportMetrics`, in the same patch as `scoreboard`.

**One reducer.** The rules of an op live once, in `applyRecordOp`
(shared/contracts/initiative), and the server and the web store both call it:
the length of each written part, the key of a new entry (a slug of its words,
numbered on a clash), the address rules of a source, and the times (a real
moment, never 0 or NaN; a question and a decision always keep their date).
An add whose key is already on the list with the same words is a retry and
changes nothing; with other words it is a different entry whose key reads the
same, and it is kept under a fresh key. A close said twice is one close: the
first date stands unless the close names another. An add may name where it
lands, which is how an undo of a remove puts an entry back where it sat. The
reducer hands back the op with everything decided (the entry whole, its key,
who and when), and the web sends that op, so the row stores the entry the
page painted. On the web the four lists hold no pending lock
(`unprotectedFields`): several writers add to one list, so the server's list
always lands whole on the next push, and an entry painted a moment before a
stale push shows again when its echo arrives.
Editing `why`, `done_when`, a milestone, a question, a decision or a source
is logged as the goal's shape (`initiative_shape`), so undo restores it.

**The shell.**

```bash
cast initiative set in-N --why - --done-when "..."
cast initiative milestone in-N "Private beta open" --date 2026-11-01 [--source <ref>]   # or "Private beta open=2026-11-01"
cast initiative milestone in-N --done <n|title> [--at 2026-09-21] | --remove <n|title>
cast initiative milestone in-N --edit <n|title> ["New title"] [--date <day|none>] [--source <ref|none>] [--at <day|none>]
cast initiative ask in-N "Do we price per seat?" [--by @handle] [--source <ref>]
cast initiative answer in-N <n> "Per seat, decided on the Sep 30 call" [--at 2026-09-30] [--replace]
cast initiative decide in-N "Ship to brokers first" [--by @handle] [--source <ref>]
cast initiative ask|decide in-N --edit <n|words> ["New words"] [--by <who|none>] [--source <ref|none>]
cast initiative source in-N <ref> [--quote "..."] [--by "Name"] [--at 2026-09-30]
cast initiative record in-N --list <list> --remove <n|key>
cast initiative report in-N key=value --source <href>     # appends to the history
cast initiative show in-N [--json]                        # prints the whole record
```

Each command reads its arguments into one op in the pure half
(`initiativeCommand.ts`: `milestoneWrite`, `saidWrite`, `answerWrite`,
`sourceWrite`, `removeWrite`) and `index.ts` only sends it. An entry is named
by the number `show` prints, by its key (a source by its address in any form
the parser reads, so `call:cl-42#14` finds `call:cl-42:14`) or by its words;
a miss prints the entries and the command to type next. A day that is due
(`--date`, `Title=YYYY-MM-DD`) is a calendar day stored through the target
day pair, and a mistyped one is refused. When something was said, reached,
answered or observed (`--at`, `--observed-at`) is a moment: a day typed is
noon of that day where it was typed, a `YYYY-MM-DDTHH:MM` is that time.
`answer` takes open questions only; an answered one keeps its answer unless
`--replace`. `--edit` sends the wire's `edit` with only what changes, and
`milestone --edit <n> --at none` reopens a milestone marked reached by
mistake. The record write answers `moved`; an add that moved nothing prints
"Already on the record of" with the entry that stands, and a source typed
again fills the quote, who and when the standing entry lacks through one
`edit`, naming what it kept. Words typed beside `--quote` are kept with it.

**Proposals.** The `initiative` and `initiative_shape` changes gain `why`,
`done_when`, `milestones`, `sources`, `questions` and `decisions`. On a goal
that exists each list is entries to add, never a replacement: an entry the
goal already holds is skipped, compared by its words whatever their case and
spacing, and an entry a full list has no room for is dropped and named in the
applied note, so one full list never refuses the rest of the change. A new
goal is created with everything the card showed, its questions and decisions
included; a proposed question or decision is signed by the person who
accepted it.

Accepting any goal change persists its evidence, so a goal a review proposed
can always say where the review read it. The sources a change names and the
evidence lines it carries are read by `parseIntentSource`. Each link of the
accepted row keeps its label as the quote and its href as the address, read
by the same parser (a codecast link is the object it opens); a label that is
only an address adds no words, and an href that is no address leaves the
label as a note. Sources the goal already holds are skipped. This happens
whether or not the change moved anything else: the owner it names already
owns the goal, the projects are already carried, a goal of that title
already exists, and the evidence still joins that goal. Running the same
change again adds nothing.

One accepted change is one log entry of up to two rows, both through the
initiatives cores: what the change moved (`performUpdateInitiative` as one
patch, or `performAddProjects`), then the sources it brought, as an
`initiative_shape` row that holds only `sources`. Undo judges each row on
its own fields, so a source the goal gains later leaves the owner, the
projects, the placement and the words free to go back, and only the sources
row stays as it is. A new goal is the exception: its sources are written
with it in the create's one row, since undoing a create cancels the goal
whole. The undo preview of a shape row that takes anything off the record
names every field it moves ("Change the parent goal and decisions of the
goal ..."), never the placement alone. The S21 round trip covers the new
fields.

What the review reads of a goal (`coverage.initiatives`,
convex/lib/orgCoverage) includes every entry its record holds: each
milestone with whether it was reached, the open and the answered questions,
the decisions, and each source as the address a change would write for it,
so a review that starts cold proposes none of them a second time.

**Where it shows.** A goal and a project each open as a sheet on the Org
screen (`/org/in-N`, `/org/pj-…`; org-staffing.md S42), in the frame every
company object shares (`SheetFrame`, `components/org/company`): the crumb,
glyph, title and id, then one head line in a fixed order (owner or lead,
state, measure, date), then Serves, Ask, and the kind's sections. In the
company's document and in a sheet's Carried by a goal and a project are one
line each (`components/org/lines`: `GoalLine`, `ProjectLine`), on one column
grid that drops the date under 860px and the owner and measure under 640px;
the owner, lead and status on a line are the same pickers the sheet uses
(`IntentPickChip`, `ProjectStatusPick`), so an edit made on a line is the
sheet's. A project's work board (`/projects/pj-…`) keeps `IntentHeader` as
its one-row header, with About back to the sheet; its target day is
`IntentTargetChip`: a click opens a date field, the day is written on blur
or Enter and never from a half typed year, and only Clear removes it. Every
surface paints the store row; the board asks the server only for what the
store has not cached, and opens by its id or its `pj-` short id. A project's
task count, on its sheet, its line and its board, is the board's rule
(`projectTaskCounts`) over the task store, never the server's enriched
counts. A goal's progress is its metric, not a task bar. A project's status
is one table (`lib/projectStatus`) everywhere it shows, and a goal's health
is `HealthChip`. One set of atoms
(`components/initiatives/InitiativeAtoms`) on every surface that names a
goal, the chart's Goals lens included: `MetricTile` (now against the target,
the trend arrow, a sparkline; sizes `tile`, `line`, `chip`),
`NextMilestoneChip`, `HealthChip`, `OwnerChip`, `ProgressBar`, `SourceLink`,
`ByChip`, `UpdateLine`. The words of a metric are the contract's
(`metricAgainst`): "412 of 1,000" toward a number to reach, "34, target
under 20" for a number to stay under or a target that is not a number, and
"target 1,000" before a value is reported; the chip carries the metric's
name and reads "34 · under 20". The line draws the bar toward the target
until two reports make a sparkline, and the sparkline rules the target only
when the series keeps a third of the height with it on the scale. A target
day and a milestone's day are days, not moments: they print through
`formatTargetDay` and turn late through `targetDayPassed` (shared/time), so
every timezone names the same day and a day is late only once the viewer's
own calendar is past it. A project's deadline is still stamped at the end of
the viewer's local day and reads through `TargetDate`'s `local` flag. A
source shows where it opens, then who said it through `ByChip` (the same
face a question and a decision wear) and when; a note has no address and
shows its words.

Every entry of the record is edited in its own row: a pencil opens the
entry's form on its own words (a milestone's title and day, a question's
words and answer, a decision's words, a source's text and who said it),
Enter saves what changed as one `edit` op and Escape leaves it as it was, so
a milestone that slips keeps its key and its source. The record is keyed by
its goal: a draft or an open form never follows the sheet to another goal.

The goal sheet (`sheets/GoalSheet.tsx`) is one scroll in the order of the
test above: the head, **Why** (one editor that writes `why`, reading
`description` as the fallback), **Measured by** (the metric tile with its
sparkline, start, target and the chain it feeds), **Now**, **Carried by**
(its projects with the trouble word, its sub goals, and "+ Project"), and
**Latest from the owner** (the newest update with its health word, "Post an
update" and older updates folded). Folded at the foot are **The record**
(`InitiativeRecord`: done when, milestones, open questions, decisions,
sources) and **Activity**. A fresh goal shows its head, Why, Measured by when
it has a metric, and one line: "Nothing recorded yet. Ask <owner> to write
what done looks like." **Activity** is the scope feed
(scopes-and-feed.md F2), the same engine and the same component a role's
sheet uses, over the goal's projects and its sub goals' projects. The scope
takes `initiative_ids`, admitted by the initiatives' own access rule, and
the feed gains what only a goal has: its updates (kind `update`), its
reached milestones, asked and answered questions and decisions (kind
`goal`), and calls whose title or summary names the goal or that one of its
sources cites (kind `call`). Calls are read newest first off the team's time
index, a window at a time from where the last page stopped, so a call behind
any number of newer ones is reached on a later page. A page keeps a few
calls; when the scan stops with calls unread, every row older than where it
stopped waits for the next page, whatever its kind, so the stream stays
newest first across pages. A goal with no projects reads only its own
sources: the ones that window a member's docs, pages, decisions and runs are
skipped when the scope holds nothing they could match. The Goals and Calls
chips are offered only on a feed whose scope names goals (`feedKindsFor`).
No second feed engine exists.

**The company as a document.** The Org screen's Read lens
(`components/company/CompanyDocument.tsx`, org-staffing.md S42; `/company`
redirects to `/org`) reads the whole company top to bottom from the store
alone: the workspace's name and one state line ("2 goals: 1 on track, 1 at
risk · 4 projects, 3 with work moving · 4 people, 4 agent roles"), the goals
with their sub goals, the projects no goal carries (only when there are
any), then the people, each with the roles they host or that report to
them, and the unhosted roles last. Every row is one of the four lines on the
one grid, so the Goals, Projects and People filters line up column for
column. A line's title opens its sheet; its background or chevron opens it
in place, and what is open is the person's own (`clientState.ui.org_expanded`),
kept across reloads and windows. An open goal shows why it matters, its
owner's latest update, and the projects and goals that carry it. The outline
is `goalsPlan`, the map's own reading, so the document and the map place
every goal the same way; `companyDoc` (`companyModel.ts`, pure) joins the
rest. A project's lead is a role it names or whose scope lists it; a whole
workspace role is nobody's lead. A goal's purpose is read one way
(`goalPurpose`: why it matters, else the first sentence of its description).
An open proposal's goals, projects and roles stand where they would sit, in
violet, with "op-N · answer in the conversation", which scrolls the thread to
the card; hovering one lights its card. Nothing is approved here. The tree
is read from the roles feeder under a signature, so no session write
repaints the document.

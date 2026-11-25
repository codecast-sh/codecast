# People in the org: reporting to roles, several managers, and profiles

Written 2026-11-21. Status: P2, P4, P6 built for people; P3 built for people, designed for roles; P5 built. Extends org-staffing.md (roles,
reporting, the Head of People) and decision areas (decisionAreas.ts).

## The facts and where they live

| Fact | Stored | Shape |
|---|---|---|
| Who a person reports to | `team_memberships.managers` | any number of people and roles, all equal |
| Who a role reports to | `org_roles.reports_to` plus `also_reports_to` | any number of people and roles, all equal |
| What a person does | `team_memberships.title`, `focus`, `labels`, `about` | short version and long version |
| Which projects a person decides for | `team_memberships.focus_project_ids`, set by `cast team focus` | project ids |

Before this, sessions read people as a bare list (`People: Jason Benn
@jasonbenn, Cam @cameron`) and could not tell who handles sales, who owns the
eval suite, or whom to bring a design question.

## P1. Reporting is routing, for every pair

One rule covers person to person, role to role, role to person and person to
role: reporting says where asks, decisions and requests go and whose view a
report appears in. It grants no access and no permission. A role a person
reports to can read only what the workspace already lets it read.

## P2. What it means for a person to report to a role

When person P reports to role R:

- **Up.** A decision P escalates (`cast decide escalate`, decisionHandoff.ts)
  goes to R, not to an admin. When R is P's only manager, the card is passed
  to R's thread and R answers it inside its grants or hands it up its own
  chain, which always ends at a person. Among several managers, see P3. A request P makes in
  chat to `@R` or in R's thread is R's to route.
- **Down.** R hands P the human work in its area: `--human` tasks in R's scope,
  decisions in R's area that need a person (decision routing ranks R's reports
  first, then focus, then load), calls and manual steps. R asks; it cannot
  compel. P can hand a thing back, and it returns to R.
- **Watching.** R's check reads P's work in its area: tasks assigned to P,
  decisions waiting on P, P's sessions bound to R's tasks. R's health counts
  them, so a decision waiting on P for over a day reads as stuck under R.
  Built: `orgPeople.roleReportsOf` is the one reading (who reports to R, by
  `rolePeopleIds`, and per person the decisions in their queue past a day and
  the open tasks assigned to them, in R's area by `coverDepth`, read with the
  reader's grants). R's card on every wake and `cast org where` carry a
  `Reports to it:` line per person; `cast brief` lists the decisions and tasks
  by id; `cast org show @R` lists the people; health's area reads `stuck`
  with a `people_waiting` signal; R's check prompt (ROLE_CHECK_PROMPT) tells it
  to read and ask by chat DM.
- **Reaching P.** R writes to P by chat DM, batched into one line set per check,
  and interrupts only for something that costs time now. It respects P's
  presence (away, hours).
- **P's own sessions** stay P's cards in P's inbox. They never ride R's card.
  A P session bound to a task R owns already sits under R by the ownership rule
  (S26), unchanged.
- **What R may not do.** Change P's access, membership, trust or profile; start
  agents billed to P's account; speak for P outside the workspace. Moving P is
  a person's act: an admin, P, or a person among P's managers.
- **No loops.** The cycle check walks people and roles together: P cannot
  report to a role whose chain runs through P.

Data: `team_memberships.managers`, a list of parties in the role table's
shape (`{kind: "user"} | {kind: "role"}`). A row from before it is read
through its old `reports_to_user_id` as a one item list, and the next write
moves it into `managers` (`orgPeople.managersOf`).

## P3. Several managers, all equal

Decided 2026-11-21 (sd-4246): no primary. A person or a role may report to
several managers, and each is a full manager.

**Built for people.**

- `managers` holds up to six parties, set as a whole list
  (`orgPeople.performSetManagers`). An admin or the person sets any list. One
  of their managers may add or remove only a manager they answer for
  (themself, or a role they manage), and anyone may let themself go. Nobody
  else can make themself someone's manager (`orgPeople.mayEditManagersAs`, the
  same rule for role Settings and, on the web, `store/orgProfile.managerEditRule`).
- The cycle check walks every line up, through people and roles
  (`orgPeople.chainReaches`, `store/orgTreeMoves.orgChainReaches`).
- An escalation reaches all managers at once: each person manager gets the
  card in their queue, and each role manager is told in its thread and can
  recommend, with the person above that role getting the card. The first
  answer settles it. A sole role manager holds the card outright (P2).
- `cast org where` and `cast org people` name every manager:
  `Ic · reports to @growth, Other`. `cast org reparent @ic --to @growth,Other`
  sets the list; `--to none` clears it.
- The chart draws a person once, under the first manager it holds. Dragging
  the card moves it off that line onto another and keeps the other managers.
  The By reports lens shows the person to each person manager.

**Built for roles.** `org_roles.also_reports_to` holds a role's other
managers; `reports_to` stays the line the chart draws it on. Routing reads all
of them through `roleManagers` (`shared/contracts/orgLead.ts`); only drawing
reads `reports_to` alone.

- `orgRoles.performSetRoleManagers` sets the whole list (`cast org reparent
  @role --to @eng,Samvit`). A drag on the chart redraws one line and keeps
  the others.
- The decision ladder (`sessionDecisions.buildLadder`) walks every line,
  nearest first, so every role above can recommend and every person a line
  ends at gets the card. A lead's own question reaches every person its role
  reports to.
- A sub-lead waiting on input wakes every role it reports to
  (`agentTasks.routeUpTargets`).
- The standing session is owned by every person among its managers, and it
  rides a parent role's card only when no person manages it
  (`lib/standingSeat.standingReportsToFields`).
- An escalation to a role manager reaches every person above that role
  (`orgLead.peopleAboveRole`, shared by server and web).

**One home for who reports to a role.** A role kept its own list of the people
reporting to it, `org_roles.reports_user_ids` (org-roles-run-work.md R6: their
goals in its brief, the morning agenda, stall notices). The fact now lives
only in each person's `managers`; `orgPeople.rolePeopleIds` is the one
reader of a role's people. `performSetReports` (role Settings, `cast role
reports`) writes each person's managers. `migrations:foldOrgManagers` moves
the older pointers (`reports_user_ids` entries that are reporting lines, and
`reports_to_user_id`) into `managers`; it is dry by default. Until it runs, an
older entry reads as goals only (below). A personal role, which has no
memberships, keeps its own list.

**Goals only.** A person the role already reports up to cannot report to it
(the line would loop), but they may still ask it to keep their goals: a founder
asking a lead they manage to track their priorities. That entry is stored on
the role's `reports_user_ids`, which now means only that: no reader folds it
into anyone's managers, so moving a role never changes what it means.
`rolePeopleIds` includes it, so the brief, agenda and stall notices still see
it. Role Settings tags it "goals only" and its self button reads "Keep my
goals". The migration settles each entry written before this once, one at a
time, so the lines it accepts never loop (`orgPeople.legacyLines`).

A role's other managers that are roles are not held to the drawn parent's
containment rule (F1): a second manager is a matrix line, not a nesting.

## P4. Profiles: what each person does

Each membership gets a profile, short and long:

| Field | Size | Example |
|---|---|---|
| `title` | up to 60 chars | Head of Agentic Quality |
| `focus` | one line, up to 140 | evals, agent quality, grader faults |
| `labels` | up to 8, lower case with dashes | quality, evals |
| `about` | markdown, up to 6000 | what they own, what to bring them and what not, how and when to reach them |
| `focus_project_ids` | existed before | Eval Suite, AgentWatch |
| `profile_updated` | who and when | Samvit, 2026-11-23 |

The person or a team admin writes it (`orgPeople.setProfile`); a Head of People
proposal applies through the same writer (P5). `cast team focus` keeps working
and writes the same `focus_project_ids`. Limits and the short line live in
`shared/contracts/personProfile.ts`.

## P5. The Head of People derives profiles bottom up

The weekly review gains a people pass. For each member it reads 30 days of
evidence `cast org inputs` already collects (sessions and the projects they
touched, commits, tasks assigned and closed, decisions answered, calls led,
chat rooms) and proposes a profile as a `person_profile` change in an
ordinary proposal, with the evidence counts under it. The person approves their
own; an admin can approve anyone's. Later reviews propose a change only on
drift ("70% of Jason's sessions moved to evals; the profile says Agent
Quality"). It proposes and applies nothing, as today.

Built: the change shape and its words are `shared/contracts/orgPersonProfile.ts`;
profiles are their own kind of proposal work (`people`, uncapped). Posting
resolves `person` to a member and stamps `user_id`, `name` and `before` (the
profile as it stood) on the change, so the card draws each field before and
after and the evidence under it. `requireAdmin` (orgProposals.ts) lets a
non-admin decide changes that are all their own profile (`ownProfilesOnly`,
also the phone's gate). The apply is `orgInit.applyPersonProfile` through
`performSetProfile`; it logs a `person` row whose undo restores the
membership's profile fields and never its role. The evidence is
`lib/orgPeopleEvidence.ts`, the `people` part of `cast org inputs`.

## P6. Every session and role gets the picture

- **Session start** (`<org-context>`, `cast org where`): one line per person,
  the short version:
  `Jason Benn @jasonbenn · Head of Agentic Quality · evals, agent quality · reports to @ashot`
- **`cast org people`**: the same lines for the whole team, with labels.
- **`cast org person @handle`**: the long version: about, the projects they
  decide for, every manager, and the people and roles reporting to them. With
  `--title`, `--focus`, `--labels` or `--about -` it edits the profile.
- **Role wake frames** carry a short line for each of the role's people with
  what waits on them (`agentTasks.roleCardOf`), and so does `cast brief`.
- **Web**: the person page (`/team/<user>`) shows and edits the profile and
  every manager; chart cards show the title and every manager; role Settings
  edit a role's managers and its people.
- **Phone**: the person page shows the profile and every manager; the person
  or an admin edits title and focus there.

## Not built yet

- `cast route --dry` naming a person when their focus or labels cover a
  request and no role does.
- Routing `--human` tasks in a role's area to that role's people.
- Editing labels and about on the phone; the phone's proposal screen decides
  a proposal only when every change in it is the viewer's own profile.
- Running `migrations:foldOrgManagers` on prod (dry run first) once this is
  deployed.

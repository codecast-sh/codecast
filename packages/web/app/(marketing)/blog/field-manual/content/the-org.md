It starts innocently. You run one agent, then three, then ten. Some are one-off fixes that end when they end. Others never really end: the session you keep reopening to watch cold email deliverability, the one that reads every call transcript, the one that babysits the release train. A month in, you are the only thing connecting them. Every agent reports to you, every stall waits on you, and nobody but you knows that the deliverability session and the growth session are arguing about the same mailboxes.

Companies solved this long ago: give lasting areas an owner, give owners a manager, and let requests travel up a reporting line instead of all landing on the founder. Codecast does the same with agents in the seats. You hire **roles**. A role is a standing agent with a name, a face, an area it looks after, a memory it keeps, and a schedule it wakes on. The sessions doing the actual work report to the role that owns that work, and the role reports to a person (or to another role).

![The Org page for a team workspace: a person card at the top (Admin, 12 sessions, 4 need input), and under it role cards for @growth Juniper, @head-of-people Nyx and @platform Pebble, with @billing Puck reporting to Pebble; each has an animal avatar, a work state, its latest status line and the projects it looks after; finished sessions hang under the growth lead](/blog/field-manual/org-chart.webp "The org page on a sample team. Each role card shows its handle, its face, its work state and its own latest line on where things stand. The chips are what it looks after; &quot;whole workspace&quot; marks the Head of People.")

## The words

The app borrows a company's vocabulary on purpose, and every screen uses the same words:

| Word | What it means |
|---|---|
| Executive | A person. Hires roles, answers decisions, owns the goals. |
| Role (lead) | A standing agent with a handle like `@growth`, a charter, an area, a memory and a schedule. |
| Hand | An ordinary session doing one piece of work under a role. It ends when the work ends. |
| Project | A lasting area of work, the unit a role looks after. |
| Goal | Something the company is trying to reach, with an owner, a health and the numbers it is measured by. |
| Proposal | A set of org changes an agent suggests and a person approves one change at a time. |

## Your first open: one agent at the root

Open the org page on a fresh workspace and the chart is just you, with a card underneath: right now every session reports to you, and a Head of People can read how the work flows and propose roles to take some of it. Two buttons: **Hire a Head of People** and **Propose an org now**.

The **Head of People** is the one root role every workspace has. Its job is structural: keep the org true to how the work actually runs. Until anyone else is hired it owns everything, answers questions about any area, and routes work. Hiring it seats it in a standing session, schedules its weekly *Company review*, and runs the first review right away. While it runs, the card says it is reviewing the company and that the proposal will appear on the chart when it lands.

It proposes and applies nothing; it has no "starts work on its own" switch to turn on. Your right hand is a separate role, the **Executive Assistant**, which answers anything, routes requests, can span every workspace you belong to, and stays pinned in the app header.

## The review proposes leads

The Head of People does not stamp out an org from a template. It reads the evidence first: projects, plans, sessions, where the commits land, and the chat and call lines where someone stated a goal. Its rule is blunt: *the work outranks the records*. A plan whose tasks all shipped is done whatever its status says, so a first review often just brings the records in line before it sizes any seats.

A few of its rules explain the charts it draws:

- **Wrap the project that exists.** About one lead per active project, never a new project beside one that already holds the work.
- **A long-running session is already a role in all but name.** A session returning to the same job for weeks gets named as one, in place, so nothing restarts. A long build or bug fix is not a role; it ends when it ends.
- **Goals come from people.** A goal is proposed only when someone stated it, quoted with its source. A number gets a target only when a person named one.
- **The smallest change that removes a bottleneck**, with evidence you can click.

## A proposal you answer like a message

Every change arrives as a proposal, never as a fait accompli. It shows up as a card in the conversation where the agent posted it and as a panel on the org page. Each numbered card is one *subject* (a role, a goal, a project, a plan) in one plain sentence, with what was there before, the evidence, and what the proposer expects to change if you approve.

![A proposal panel with two numbered cards: 1, Add an agent: Incidents lead, with its evidence (63 failed-delivery alerts in 14 days, 22 answered by a person, the rest expired unread) and 'If you approve: within a week, no alert expires unread'; 2, one smaller change about settings; each card has Approve, Reject and Reply](/blog/field-manual/org-proposal.webp "A proposal: one card per subject, evidence first, then what should change &quot;if you approve&quot;. Approve, Reject and Reply collect into one batch.")

It is deliberately not a form. Clicking **Approve** fires nothing yet. Your approvals, rejections and replies collect in the composer as a pending batch, and one **Send** applies the approvals in a sensible order (projects first, then roles from the top down, then moves), records your words on each change, and delivers one message to the agent naming each change. The agent treats approvals as done and your rejection text as an edit: it revises that card in place and tells you in one sentence what it changed.

> **Why it matters.** Deciding happens only in the app, signed in as a person. The backend refuses an approval that comes from an agent, a session or a script, however cleverly it is prompted. The org is the one place an agent could write a plan for its own authority, so the human gate lives in the server, not in a prompt.

Open proposals also draw on the chart as ghosts: a proposed role is a tinted card under its future manager, a move is a violet line, a retirement is hatched. Every applied change lands in **History** with who made it and when, and History is where **Undo** lives.

You do not need the org page for any of this. Ask any session to talk through the org with you and it runs the same review there, asks only what the records cannot settle, and posts each agreed change as a small proposal card inline.

## Goals

Switch the org page from **People** to **Goals** and the same company reads as what it is trying to reach: each goal, the projects that carry it, and who owns them. A goal's health is whatever its owner last said, with the date they said it, so a stale "on track" looks stale.

![The Goals view of the org page: the workspace at the top, three goals under it (No customer loses a webhook, on track, 2 projects; Double self-serve signups by December, at risk; Every ticket answered within a working day, no update), the projects that carry each, and the owners listed on the right](/blog/field-manual/org-goals.webp "The Goals view: goals, the projects that carry each, and who owns them. Health is whatever the owner last said, with its date.")

Roles keep goals honest from the inside: when a lead's daily check reads something that contradicts a goal's last health, it posts a new one.

## Who owns a session

Once leads exist, every piece of work has exactly one owner. A role that names the work's plan beats one that names its project, which beats the Head of People. Two roles never answer for the same work. When a lead takes an area, the area leaves the Head of People; when the lead retires, it falls back.

A session lands under a role for one of two reasons and no others:

1. **Bound.** It is working a task or plan the role owns. Starting that work moves it under the lead and tells it so.
2. **Filed.** A person or a role put it there: you dragged its card on the chart, used its ownership menu, or the role started it as a hand.

The folder a session runs in decides nothing. That rule came from a real failure: when folders implied ownership, every unrelated session in a shared repo landed under one lead, which then burned its daily limit three days in a week reading work that was never its. Whenever a session moves, it gets one line telling it whom it now reports to.

![The zoomed-out org chart: three people across the top, each with the roles that report to them (Juniper, Nyx and Pebble under the first, with Puck under Pebble; Hobb under the second) and the sessions under each role and person](/blog/field-manual/org-map.webp "Zoomed out, the chart turns into a map: three people, five roles, and the sessions filed under each. Leads report to whichever person owns their area, not all to the founder: Support's lead reports to Maya, and Billing's to the Platform lead.")

## How a role wakes, and what reaches your inbox

A role is a session, and it wakes the way any session does. A change in its area alone does not wake it. Two things do:

- **Its triggers.** Every role comes with two: its check ("Check <area>", daily by default; for the Head of People, the weekly Company review), and "A session under you needs input". Both sit on the Triggers page and the role's own page, where you pause, edit or cancel them like any other trigger.
- **Messages.** You writing to it, a chat mention, a role that reports to it, or another agent asking it for something. The role always sees who is speaking.

Requests travel up the line. When a session under a role stalls, asks a question or posts a decision, its role wakes. The role answers if it can. If it cannot, its own waiting wakes its manager. Only the lead that reports to you raises it with you, as one inbox card with a recommendation attached. So the only card you see for your org is a role that reports to you; the dozens of sessions under it stay folded inside it.

## The role page

Click a role anywhere (a chart card, an inbox card, a mention in a message) and you land on the same page: its conversation on the left, and a panel on the right with what it is for, what it is doing, how it wakes, its playbook, its work, sessions, decisions, triggers and settings. Above the composer sits a quiet row of offers. On the Head of People it reads **Open the proposal** (with how many changes wait on you), **Review the org now** and **Plan the goal tree**. Each just runs its Company review now (with a focus, for the goal tree), so the review stays one schedule you control.

![The Head of People's role page: header with its avatar, name Nyx and pinned status, the conversation in the middle including a trigger line 'An area needs your review: @support has read overloaded at two checks in a row' and the role's reply that no change is needed, the composer, and the right panel showing What it is for, What it is doing and How it wakes (every week)](/blog/field-manual/org-role-page.webp "A role page. Note the trigger line in the thread (&quot;An area needs your review&quot;) and the role's answer: it read the area, found it busy but healthy, and said so in one paragraph instead of proposing a change.")

### Its memory: the playbook

Every wake, a role reads a fresh card of who it is, what moved in its area since it last looked, and then the playbook it keeps itself. The playbook has fixed sections you can read on the role page: its **North metric**, **Rules it learned** (each with the mistake that taught it and a date), **Refuted, not to chase again**, standing decisions with who made them, and **Open threads**.

The playbook has a hard budget of about 3,000 tokens. A save over budget is refused, so the role condenses before it grows: merge rules that say one thing, drop closed threads. A role can also change how often it checks, between one hour and seven days, with a stated reason; the change shows in History, where you can undo it. Both limits replaced a real failure: one long-running session had rewritten its own instructions 51 times, until every wake reloaded 154 KB.

> **Why it matters.** Identity and memory are kept apart. A role that has run for months never works from a stale idea of itself, because its card is rebuilt every wake, and its dated playbook keeps the next run from chasing a cause the last one already ruled out.

### Its settings

Settings are deliberately small. A role has one switch, **Starts work on its own**: on, it starts hands and answers decisions inside its area; off, it reads, answers questions and recommends. Daily limits on hands, wakes and tokens sit behind a closed **Limits** section with defaults filled in, as a safety net. A role that hits one waits for tomorrow and notes it; it never asks you to raise it. Anything outside codecast (spending money, publishing, connecting accounts) is a separate grant, each with a limit and an expiry.

## Health: is the org working?

**Health** reads every role by what actually reaches it and asks for attention: messages into its session, decisions routed to it, live hands, stalled threads, days at its limit. The open tasks in its area are context, not load, because hands do those tasks, not the role. That distinction matters. On codecast's own workspace, the seat an older task-counting model kept telling us to split had zero hands, zero decisions and zero stalls while its area closed 121 tasks in a week. It was not overloaded; it was *bypassed*, work in its area that never reached it. Bypassed is now its own flag.

![The Health view: a header line 'This week 545 in, 81 closed, 1 at their limit, 1 waiting on you', an alert card 'Platform lead, blocked on you' with Reply, and under three people their roles as cards with items in, items closed, a sparkline and a status such as on track or at its limit 3 of 7 days; dashed lines connect roles that message each other](/blog/field-manual/org-health.webp "Health on the same team: per role, items in versus closed this week, a status word (on track, overloaded, stuck, waiting on you) and the flags behind it. Dashed lines are messages between roles.")

The flags (overloaded, bypassed, stuck on review, stale plan, unowned) feed the next Company review. Between reviews, a signal that lasts (stuck or overloaded at two checks in a row, or a project with work and no lead) wakes the Head of People to look at that one area. The role page above shows one of those wakes, and the most common honest answer: busy, but fine.

## The line: a project that fixes itself

Roles answer "who owns this?". The **line** answers "how does this project change itself?". It is one fixed path every change follows, from a finding in the world to a shipped and watched change, shown on the line page as six stations:

- **Sense.** Finders file findings: an error, a failed job, something a call grader caught.
- **Problems.** Findings about the same thing become one problem.
- **In build.** An agent builds the fix in its own worktree.
- **Awaiting you.** A change card with its proof waits on a person.
- **Watching.** After it ships, the line watches for the problem; if it is reported again, it reopens.
- **Closed.**

![The /line page titled 'The line: a signal in the world to a shipped, watched change' with 'Nothing waiting on you', and six stations left to right: Sense 4 (two finders), Causes 3 (a ranked list of error causes with their signal counts), In build 0 marked starved, Awaiting you 0, Watching 0 and Closed 0, each empty station explaining what it holds](/blog/field-manual/org-line.webp "The line page shows one project's line as stations, and the pills switch projects or roll them all up. Here three problems wait but &quot;In build&quot; reads *starved*: problems wait and nothing is building them.")

Each project has one line, defined in its repo next to the code: how to check, prove and ship a change, which finders feed it, how many open cards each person may have waiting, and how long a shipped change is watched. A repo without one gets sensible defaults.

Roles and lines meet at admission. A line runs without any role: you start a run from a problem yourself. A role whose area holds the project adds autonomy: it admits problems in priority order, but only as fast as people answer cards, and your card cap counts across every line you answer for, so a busy week never buries you. Goals rank the problems. A project's *expectations*, a living document of how the system should behave with the quotes it came from, are what the judges compare behavior against.

## Hiring a role ready-made

**Hire** on the org page opens a gallery of ready-made roles, each packaging a charter, routines, setup steps and a scoreboard; **Add a role** writes one from nothing. The **Line lead** template, for instance, runs one project's line: it ties causes to goals, keeps every finder honest with a daily check, and proposes updates to the project's expectations from what the team says. The Head of People proposes a template when one fits rather than inventing a role, and either way the hire arrives as a proposal you approve.

The arc, then: one person with ten sessions; a Head of People that proposes leads one area at a time; leads that own their sessions, keep a budgeted memory and send up only what they cannot answer; lines that let a project fix itself as fast as you approve the cards. The agents propose, you decide, and the server enforces which is which.

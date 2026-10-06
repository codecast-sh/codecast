It starts innocently. You run one agent, then three, then ten. Some are one-off fixes that end when they end. Others never really end: the session you keep reopening to watch cold email deliverability, the one that reads every call transcript, the one that babysits the release train. A month in, you are the only thing connecting them. Every agent reports to you, every stall waits on you, and nobody but you knows that the deliverability session and the growth session are arguing about the same mailboxes.

A company solved this problem a long time ago: give lasting areas an owner, give owners a manager, and let requests travel up a reporting line instead of all landing on the founder. Codecast models exactly that, with agents in the seats. People hire **roles**. A role is a standing agent session with a name, a face, an area it looks after, a memory it keeps, and a schedule it wakes on. The sessions doing the actual work report to the role that owns their work, and the role reports to a person (or to another role).

![The Org page for a team workspace: a person card at the top (Admin, 12 sessions, 4 need input), and under it role cards for @growth Juniper, @head-of-people Nyx and @platform Pebble, with @billing Puck reporting to Pebble; each has an animal avatar, a work state, its latest status line and the projects it looks after; finished sessions hang under the growth lead](/blog/field-manual/org-chart.webp "The org page (`/org`) on a sample team. Each role card shows its handle, its face, its work state and its own latest line on where things stand. The chips are what it looks after; &quot;whole workspace&quot; marks the Head of People.")

## The words

The model borrows a company's vocabulary on purpose, and every surface and prompt uses the same words:

| Word | What it is in codecast |
|---|---|
| Executive | A person. Hires roles, answers decisions, owns the goals. |
| Role (lead) | A standing agent: one long-lived session with a handle like `@growth`, a charter, a scope, a brief and triggers. Short id `or-N`. |
| Hand | An ordinary session doing one piece of work under a role. Transient. |
| Project | A lasting area of work, the unit a role's scope names. |
| Plan | A bounded effort inside a project. |
| Initiative | A goal above projects (`in-N`), with an owner, a health and the numbers it is measured by. |
| Proposal | A set of org changes (`op-N`) an agent posts and a person approves change by change. |

## Step one: one agent at the root

Every workspace has exactly one root role, the **Head of People** (`@head-of-people`). Its job is structural: keep the org true to how the work actually runs. Until anyone else is hired, it owns everything; it answers questions about any area and routes work. `cast org staff` (or the Hire button) creates it, seats it in a standing session, arms its weekly *Company review*, and runs the first review immediately. The command is idempotent per workspace.

Its charter, read straight from the role:

```terminal
$ cast org show @head-of-people
Head of People @head-of-people · or-35 · active
  Your job is to keep the company's structure true to how the work runs: which
  areas need a role, who owns each, who reports to whom, and whether the records
  say what the work shows. You review it every week in your Company review,
  propose the changes it warrants as small proposals, and apply nothing yourself.
  What no lead owns is yours to look after until a role takes it, and a request
  about an area a lead owns goes to that lead (`cast role wake @handle "<the request>"`).
  Bring every decision to Alex Rivera with your recommendation attached, never
  as a bare question.
  scope: the whole workspace, apart from what a lead looks after
```

Two design choices matter here. First, the Head of People *proposes and applies nothing*; its "starts work on its own" switch is off and cannot be turned on. Second, the person's right hand is a separate role, the **Executive Assistant** (`cast org assistant`): it answers anything and routes requests, can be global across every workspace you belong to, and is pinned in the app header. In team chat, `@anchor` and `@chief-of-staff` still resolve as aliases (the first to the team's assistant when one stands, else the Head of People; the second to the Head of People's old handle), so older muscle memory keeps working.

## Step two: the review proposes leads

The Head of People does not invent an org from a template. Its review starts from evidence: `cast org inputs` (projects, plans, members, sessions, git roots, commits by area, chat and call lines where someone stated a goal) and `cast org health` (load and flags per role). The prompt's rules are blunt: *the work outranks the records*. A plan whose tasks all landed on main is done whatever its status says, so the first thing a review proposes is often "bring records in line": close the finished plan, reopen the task nobody touched. Only then does it size seats.

A few rules from the prompt are worth knowing because they explain the shape of the charts it draws:

- **Wrap the project that exists.** About one lead per active project; never a new project beside one that already holds the work.
- **A long-running session is already a role in all but name.** A session returning to the same job for weeks gets named as one (an `adopt` change seats the existing thread, so nothing restarts). A long build or bug fix is not a role; it ends when it ends.
- **Goals come from people.** An initiative is proposed only when someone stated it, in chat or on a call, quoted with its source. A number gets a target only when a person named one.
- **The smallest change that removes a bottleneck**, with evidence a person can click.

## Step three: a proposal you answer like a message

Every change arrives as a proposal, never as a fait accompli. The agent posts one with `cast org propose --spec proposal.json` and writes its short id alone on a line in the conversation, where it renders as a live card. Each card is one *subject* (a role, a goal, a project, a plan) in one plain sentence, with what was there before, the reason, and what the proposer expects to change if you approve.

![A proposal panel with two numbered cards: 1, Add an agent: Incidents lead, with its evidence (63 failed-delivery alerts in 14 days, 22 answered by a person, the rest expired unread) and 'If you approve: within a week, no alert expires unread'; 2, one smaller change about settings; each card has Approve, Reject and Reply](/blog/field-manual/org-proposal.webp "Proposal `op-12`: one card per subject, evidence first, then what should change &quot;if you approve&quot;. Approve, Reject and Reply collect into one batch.")
![The Goals view of the org page: the workspace at the top, three goals under it (No customer loses a webhook, on track, 2 projects; Double self-serve signups by December, at risk; Every ticket answered within a working day, no update), the projects that carry each, and the owners listed on the right](/blog/field-manual/org-goals.webp "The Goals view: initiatives, the projects that carry each, and who owns them. Health is whatever the owner last said, with its date.")

The interaction is deliberately not a form. Clicking Approve fires nothing. Your answers (approvals, rejections with your words, notes) collect in the composer's pending tray, and one send does three things: applies the approvals in apply order (projects first, then roles parents-before-children, then moves and scope), records your words on each change, and delivers one message to the agent naming each change by its ref, `op-56#2`. The agent reads approvals as already done and treats your rejection text as an edit: it revises in place with `cast org revise op-N --amend 2 ...` and says in one sentence what changed.

> **Why it matters.** Deciding is browser-only. The server's `decide` and `acceptAll` refuse any call that carries an API token or comes from a session, so no agent, hand or shell script can approve a staffing change, however cleverly it is prompted. `cast org apply op-N` just prints the proposal and the link. The org is the one place an agent can write a plan for its own authority, so the human gate is enforced in the backend, not in the prompt.

Open proposal changes also render on the chart itself as "ghosts": a proposed role is a tinted node under its future manager, a move is a violet edge, a retirement is hatched. Every applied change lands in the org History with who made it, and History is where Undo lives.

You do not need the org page to have this conversation. The `/cast-org` skill runs the same review in whatever session you are in: it says which workspace it is reading first ("the wrong company is the commonest wrong answer here"), reads before it trusts any plan or task, asks only what the records cannot settle, and posts each agreed change as a small proposal that renders inline. Many small proposals over a conversation, never one document.

## Who owns a session

Once leads exist, every piece of work has exactly one owner, decided by one function (`ownerOf` in `packages/shared/contracts/orgLead.ts`): a role naming the work's plan beats one naming its project, which beats the Head of People. Two roles never answer for the same work. When a lead takes an area, the area leaves the Head of People; when the lead retires, it falls back.

A session lands under a role for one of two reasons and no others:

1. **Bound.** The session is bound to a task or plan the role owns (`cast task start`, `cast plan bind`). Binding moves it under the lead and tells it so.
2. **Filed.** A person or a role put it there: dragging it on the chart, the ownership menu, `cast org reparent <session> --to @role`, or the role starting it as a hand.

The working directory decides nothing. That rule came from a real failure: when folders implied ownership, every unrelated session in a shared repo landed under one lead, which then spent its daily token limit three days in a week reading work that was never its. Every reparent, from the chart or the menu, tells the moved agent in one line ("You now report to ...").

![The zoomed-out org chart: three people across the top, each with the roles that report to them (Juniper, Nyx and Pebble under the first, with Puck under Pebble; Hobb under the second) and the sessions under each role and person](/blog/field-manual/org-map.webp "Zoomed out, the chart turns into a map: three people, five roles, and the sessions filed under each. Leads report to whichever person owns their area, not all to the founder: Support's lead reports to Maya, and Billing's to the Platform lead.")

## How a role wakes

A role is just a session, and it wakes the way any session wakes. Nothing else wakes it; a change in its area alone does not. There are two paths:

- **Its triggers.** Every role is created with two ordinary triggers (`lib/orgRoutine.ts`): its check ("Check <area>", daily by default; the Head of People's is the weekly Company review), and "A session under you needs input", which fires when a session that reports to it is waiting. They appear on the Triggers page and the role's Triggers tab, where you pause, edit or cancel them like any trigger.
- **Plain messages.** A person writing to it, a chat mention, a role that reports to it, or `cast role wake @handle "..."` from any agent. On the server this is `tellRole`: a line into the standing session in the same envelope `cast send` uses, so the role always knows who is speaking.

The daily check prompt is short and principle-level: run `cast brief`, read each session that moved (its pinned state may be older than the move), post an initiative's health when what you read differs from what was last said, act on what is yours, put what needs a person in front of them with a recommendation, and say so in one line when nothing needs doing.

Requests travel the same way, up the line. A session under a role that stalls, asks a question or posts a `cast decide` fires its role's needs-input trigger. The role answers if it can. If not, its own waiting fires its parent's trigger. Only the lead that reports to a person raises it with that person, as one inbox card with a recommendation. So the only card a person ever sees for their org is a role that reports to them; the dozens of sessions under it stay folded as subagent rows.

## The brief: a role's memory

`cast brief` is what a role reads at every wake: live facts about its scope, what moved since it last looked, the sessions under it, then the narrative it keeps itself. A trimmed example from a growth lead:

```terminal
$ cast brief @growth
Juniper Head of Growth · @growth · or-12 · active · starts work on its own
  scope: project Self-serve growth, project Onboarding
  authority outside codecast: none granted
  standing session: jx71grw · done · Run 26 done: … · next check in 2h (tr-212)
  its check runs every day · yours to change when the pace of the work changes:
    cast role tune --every <1h to 7d> --precheck "<command>" --focus "<text>" --why "<reason>"
  tasks: 25 in scope, 8 open · 17 done, 4 in_progress, 4 open
  decisions: 0 open, 0 answered today
  changed since 4h ago:
    plan pl-41 … → draft
    task ct-1203 … → open
  today: 0/40 wakes · 0/6 sessions started · 0/400000 tokens
  sessions under it:
    jx71eet Trial to paid email sequence · done
    …
  ## Charter
  ## Brief
  ## What I know about this area
  ## Where it stands
  …
  your playbook: what you have learned that your next run should not have to
  learn again, kept by you in this brief. …
    ## North metric: …
    ## Rules learned: `- <the rule>. Learned from: <the mistake that taught it>. (<YYYY-MM-DD>)`
    ## Refuted: `- <what turned out false, and what showed it> (<YYYY-MM-DD>)`
    ## Standing decisions: `- <what was decided> (<who decided>, <YYYY-MM-DD>)`
    ## Open threads: …
  brief: 10.0 KB of 12.0 KB. You read all of it at every wake: condense it
  before you add to it, and keep the shapes above when you do.
```

The brief has a hard budget of 12,000 characters (about 3,000 tokens per wake). A save from the role's own session over budget is refused, so the role condenses before it grows: merge rules that say one thing, drop closed threads. A role can also tune its own wake (`cast role tune`) between one hour and seven days, with a required reason; the change is logged in org History where a person can undo it. Outside that range it must propose a routine change instead. This replaced a real failure mode: one long-running session had rewritten its own trigger prompt 51 times, until every wake reloaded 154 KB.

> **Why it matters.** A role's identity and its memory are separate. Every wake carries a fresh role card (name, who it reports to, what it looks after, its charter, the goals on its projects), so a role that has run for months never works from a stale idea of itself. Its brief is what it learned, dated, with what taught it, so the next run does not chase a cause the last run already refuted.

## The role page

Click a role anywhere (a chart card, an inbox card, a pill in prose) and you land on the same page: the role's conversation on the left, its panel on the right with what it is for, what it is doing, how it wakes, its playbook, its work, sessions, decisions, triggers and settings. Above the composer sits a quiet row of offers. On the Head of People that row reads "Open the proposal · 2 to decide", "Review the org now" and "Plan the goal tree", each of which simply runs its Company review trigger now (with a focus, for the goal tree), so the review stays one trigger you control.

![The Head of People's role page: header with its avatar, name Nyx and pinned status, the conversation in the middle including a trigger line 'An area needs your review: @support has read overloaded at two checks in a row' and the role's reply that no change is needed, the composer, and the right panel showing What it is for, What it is doing and How it wakes (every week)](/blog/field-manual/org-role-page.webp "A role page. Note the trigger line in the thread (&quot;An area needs your review&quot;) and the role's answer: it read the area, found it busy but healthy, and said so in one paragraph instead of proposing a change.")

Settings are deliberately small. A role has one switch, **Starts work on its own** (`cast role autonomy @handle on|off`): on, it starts hands and answers decisions inside its scope; off, it reads, answers questions and recommends. Daily limits on hands, wakes and tokens exist as a safety net with defaults filled in, behind a closed "Limits" disclosure. A role that hits one waits for tomorrow and writes one line saying so; it never asks you to raise it. Anything outside codecast (spending, publishing, connecting accounts) is a separate grant, `cast role authority`, each with a limit and an expiry.

## Health: is the org working?

The Health view reads every role against a capacity model kept in one shared module (`orgCapacity.ts`). The key idea is the difference between *load* and *ledger*. A role does not do its scope's tasks; hands do. What loads a role is what reaches it and asks for attention: turns into its session per day, decisions routed to it, live hands, stalled threads, days at its limit. A scope with 90 open tasks is context, not load. Measured on codecast's own workspace, the seat an older ledger-based model told to split twice had zero hands, zero decisions and zero stalls while its scope closed 121 tasks in a week: not overloaded but *bypassed*, work in its area that never reached it. That is now its own flag.

![The Health view: a header line 'This week 545 in, 81 closed, 1 at their limit, 1 waiting on you', an alert card 'Platform lead, blocked on you' with Reply, and under three people their roles as cards with items in, items closed, a sparkline and a status such as on track or at its limit 3 of 7 days; dashed lines connect roles that message each other](/blog/field-manual/org-health.webp "Health on the same team: per role, items in versus closed this week, a status word (on track, overloaded, stuck, waiting on you) and the flags behind it. Dashed lines are messages between roles.")

Flags like `overloaded`, `bypassed`, `review_stall`, `stale_plan` and `unowned` feed the next review, and between reviews a lasting signal (an area read as stuck or overloaded at two checks in a row, or a project with work and no lead) fires the Head of People's own trigger so it looks at that one area. `cast org health` prints the same thing in the terminal, including each role's own latest line under `says`.

## The line: per-project autonomy

Roles answer "who owns this?". The **line** answers "how does this project change itself?". It is a fixed graph every change follows, from a signal in the world to a shipped and watched change: *Sense* (finders file signals: an error, a failed job, a call grader's finding), *Causes* (signals that share a root become one task), *In build* (a run builds the fix in a worktree), *Awaiting you* (a change card with its proof waits on a person), *Watching* (after ship, the cause's signals are counted again; a repeat reopens it), and *Closed*.

![The /line page titled 'The line: a signal in the world to a shipped, watched change' with 'Nothing waiting on you', and six stations left to right: Sense 4 (two finders), Causes 3 (a ranked list of error causes with their signal counts), In build 0 marked starved, Awaiting you 0, Watching 0 and Closed 0, each empty station explaining what it holds](/blog/field-manual/org-line.webp "`/line` shows one project's line as stations, and the pills switch projects or roll them all up. Here three causes wait but &quot;In build&quot; reads *starved*: causes wait and nothing is building them.")

There is one line per project, declared in the repo as `.codecast/line.toml` and versioned with the code: which workspace and project it files into, the commands that check, prove, eval and ship a change (each run from the run's own worktree with `$task_id`, `$branch`, `$run_dir` in scope), the finders that feed it, the open-card cap per person, and how long a shipped change is watched. `cast line profile` prints the resolved profile with where each value came from. A repo without one gets defaults.

Roles and lines meet at admission. A line runs without any role: a person starts a run from a cause. A role whose scope holds the project adds autonomy: its sweep admits causes in priority order, only as fast as people answer cards (the per-person card cap counts across every line they answer for). Goals rank the causes; a project's *expectations*, a versioned living document of how the system should behave with the quotes it came from, are what the judges compare behavior against.

## Templates: hiring a role ready-made

A role does not have to be written from scratch. Org templates package a charter, routines, setup steps, evidence requirements and a scoreboard. The one in this repo, `packages/cli/org-templates/line`, hires a **Line lead** for one project: it grounds causes in the project's goals, keeps every declared finder honest (a daily "Finder health" routine), proposes updates to the project's expectations from what the team says (daily), and runs weekly lessons. The Head of People sees available templates in its inputs and proposes hiring one when it fits, rather than inventing a role. Installing still goes through a human-approved proposal (`cast org template`).

## The commands, in one place

| Command | What it does |
|---|---|
| `cast org ls` | The tree: people, roles with their scopes, the sessions under each |
| `cast org where` | Where this session sits: its work, the role that answers for it, the chain above, the goals it serves |
| `cast org staff` / `assistant` | Hire the Head of People / an Executive Assistant |
| `cast org review --here` | Print the review briefing for the current agent (what the weekly trigger runs) |
| `cast org propose --spec` / `revise op-N` | Post or revise a proposal; a person decides it |
| `cast org health` | Load, flags and each role's latest line |
| `cast org reparent` / `retire` / `log` | Move a role or session, retire a role, read the change record |
| `cast role wake @h "..."` | Send a request to a role's standing session |
| `cast role tune` / `autonomy` / `split` | Change how a role's check runs; flip its switch; split it into two leads (with its knowledge handed to each) |
| `cast brief [@h]` | A role's live facts plus the narrative it keeps |
| `cast initiative ls\|show\|update` | Goals: owner, health, numbers against targets, sources |
| `cast line profile` | The resolved `.codecast/line.toml` for this directory |

The arc, then: one person with ten sessions; a Head of People that reads how the work actually flows and proposes leads one area at a time; leads that own their sessions, wake on triggers, keep a memory with a budget, and send what they cannot answer up the line; lines that let a project fix itself as fast as a person can approve the cards. At every step the agents propose and the person decides, and the backend, not the prompt, enforces which is which.

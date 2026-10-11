Some jobs are the same every time: pick up where yesterday's work stopped, hand a piece of work to a teammate, get a second opinion before shipping, see a pull request through to merge. An agent asked to do one of these from scratch does it a little differently each time, and skips steps. Skills are the codecast versions of those jobs, written down once: slash commands your agent runs the same careful way every time.

What makes them worth having is that they reach past one session. A skill can read your task board, your team's earlier sessions, other sessions working right now, pull requests, calls and team chat, which a single agent on its own can't see.

![A conversation started with /cast-second-opinion: the agent sends the change to a second model, checks each finding against the code, fixes the two real bugs and lists what it left alone](/documentation/skills/conversation.webp "/cast-second-opinion on a small change. The skill shows as a pill on your message; the agent got a review from a different model, verified both findings, fixed them, and left two judgment calls to you.")

## Turn it on

Skills work with Claude Code.

1. Open **Agent features** from your account menu and pick the computer your agents run on.
2. Switch on **Skills**, under *Tracking & automation*.
3. Start a new session. The commands are there.

![The Skills feature's detail in Agent features](/documentation/skills/skills-feature.webp "The Skills detail. The switch at the top right turns it on for the selected computer.")

A skill costs nothing until it runs. Your agent sees a one-line description of each, and reads the steps only when one is used.

## Use one

Type `/` in the message box of any Claude Code session, in the web app or the Mac app, and a menu lists the commands available there. Keep typing to filter, and pick one with the arrow keys and Enter. Add anything the skill should know after the name: a task, a file and line, a question.

![The slash command menu in the message box, filtered to cast- skills, each with its description](/documentation/skills/slash-menu.webp "Type / to see every skill and command for the session, with what each does.")

You don't have to remember the names. Ask in plain words and the agent picks the skill that fits: "hand this over to tomorrow's session", "get another model to look at this before I merge", "what did the team do yesterday?"

## The skills

Start, stop and hand over:

| Command | What it does |
|---------|--------------|
| `/cast-pickup` | Reads the task, the session's pinned state, what the team did recently and the state of the code, then names the work and the next three steps |
| `/cast-handoff` | Writes down the decisions, what's verified, open questions and next steps as a shared doc, so the next session or a teammate can continue without reading the thread |
| `/cast-pass` | Hands this session to a teammate: it lands in their inbox with where things stand and what's next |
| `/cast-ask-team` | Posts a question to team chat with enough context to answer it cold, pauses the session, and picks up again when someone replies |
| `/cast-worktree` | Moves the work into its own isolated copy of the repository, so it can't collide with other sessions |

Plan and reconsider:

| Command | What it does |
|---------|--------------|
| `/cast-plan` | Explores the code, looks for earlier attempts in past sessions, asks you the open questions, then writes a plan with tasks for the team to review |
| `/cast-rethink` | Steps back and rebuilds the history of a piece of work from earlier sessions and decisions before touching code |
| `/cast-bakeoff` | Tries several approaches in parallel, one branch of the conversation each, then compares them side by side with a verdict |
| `/cast-conflicts` | Finds other live sessions changing the same files, shows what they changed, and warns them |

Prove and ship:

| Command | What it does |
|---------|--------------|
| `/cast-verify` | Runs the checks, tries the change in your browser or on the command line, and attaches screenshots and output to the task |
| `/cast-ship` | Commits in sensible pieces, opens the pull request, and stays with it so reviews and failing checks wake the session until it merges |
| `/cast-review` | Reviews another session's work from its conversation and changes, and sends it the findings with file and line |
| `/cast-second-opinion` | Has a different model review the change in a fresh context, then checks each finding before acting on it |
| `/cast-why` | Explains why a line of code is the way it is, from the session that wrote it and the message where it was decided |

Run the day:

| Command | What it does |
|---------|--------------|
| `/cast-morning` | What waits on you: sessions that need input, pull requests, ready tasks, what ran overnight, unread chat and mail |
| `/cast-eod` | Closes the day: makes sure each live session says where it stands, writes handoffs, sets up overnight follow-ups, tidies the inbox |
| `/cast-standup` | A digest for a time window from the team's sessions, commits, tasks, pull requests, calls and chat |
| `/cast-triage` | Tidies a crowded inbox: clears finished and stalled sessions and surfaces the few that need you, with a one-line ask each |
| `/cast-loop` | Works through a queue of ready tasks unattended, one fresh session per task, each verified and opened as a pull request for you to merge |

Learn and keep records true:

| Command | What it does |
|---------|--------------|
| `/cast-learn` | Turns what this session learned (your corrections, decisions, gotchas) into guidance the next session will read |
| `/cast-lessons` | Collects the corrections people made across the team's sessions and proposes the guidance that would have prevented each |
| `/cast-from-call` | Turns a call's action items into tasks, each linked to the moment in the transcript where it was agreed |
| `/cast-org` | Talks through who works on what, for agents and people, and posts each agreed change for you to approve |

Build things in codecast:

| Command | What it does |
|---------|--------------|
| `/cast-mod` | Builds a mod (a pane, a command or a new kind of block in the app) with you watching each change live |
| `/cast-dashboard` | Builds a live dashboard as a published page over your team's work and product data; every chart shows its query and refreshes itself |
| `/cast-motion` | Makes an animated explainer, published as a page that plays, scrubs and takes comments pinned to moments |

## What you see

The skill shows as a pill on your message, so you can tell at a glance which conversations ran one. The agent's steps appear in the conversation like any others, and what a skill produces lands where it belongs: a handoff as a doc, a plan on the Plans page, evidence on the task, a pull request on its page with the session shown as its shepherd, a dashboard as a published page.

## What they will and won't do

- **They follow the same rules as the agent.** A skill adds no new powers. It is the same agent with the same permissions, following a fixed sequence of steps.
- **Leaving a mark still waits for you.** `/cast-ship` opens a pull request but doesn't merge it. `/cast-loop` never merges either. `/cast-org` posts proposals for you to accept rather than changing the org itself.
- **Your own skills are safe.** Turning Skills off removes the codecast skills and nothing else; any skills you wrote yourself stay.
- **They stay current.** When codecast updates, improved skills reach your machine without you doing anything.

## When something is off

| What you notice | What to do |
|-----------------|------------|
| Typing `/` shows no cast- commands | Check Skills is on for the computer the session runs on, then start a new session |
| The session isn't Claude Code | Skills are Claude Code commands. Ask a Claude Code session, or describe the job in plain words |
| A skill stops to ask you something | Some skills (`/cast-plan`, `/cast-org`) interview you on purpose. Answer in the conversation and it continues |

Orchestrating a whole plan across several agents is its own feature; see [orchestration](/documentation/orchestration).

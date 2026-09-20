# Changelog

What we shipped, month by month. Newest first.

The rendered version lives at **[/changelog](https://codecast.sh/changelog)**.
Both this file and the page read from one curated source,
`packages/web/app/(marketing)/changelog/changelogData.ts`. To refresh after a
release, run `node scripts/changelog-mine.mjs <YYYY-MM>` to see what shipped,
then extend that file.

---

## September 2026: The org, pull requests, and sessions in the cloud
**v1.1.114 – v1.1.143 · Desktop v1.1.112**

This month codecast got a shape for standing work. A role sits in an org tree
and holds a responsibility after any one session ends, so a task or a mention
goes to the role and not to whoever happens to be running. Pull requests and
issues became objects that a session owns and answers. Sessions start on a cloud
host with one flag, idle ones hibernate, and `cast browser` moved into your own
Chrome.

- **The org: roles that outlive sessions** (Sep 13 to 18). A role is a seat in an org tree with a scope, a standing brief and a standing session. Assign it a task or mention its handle in chat and its session wakes. `cast org init` reads the code and your sessions, then proposes seats for you to accept. Deep dive: [The org](https://codecast.sh/documentation/org-roles).
- **Pull requests and issues join the board** (Sep 4 to 14). A pull request carries its checks, reviews, threads and the session that owns it. `cast pr shepherd on` binds a session; a review, a failing check or a merge conflict wakes it. Review from the shell as one batch. Linear and GitHub issues sync both ways as tasks. Deep dive: [Pull requests and issues](https://codecast.sh/documentation/pull-requests).
- **Cloud sessions and a fleet that sleeps** (Sep 4 to 17). `cast spawn --cloud` starts a session on a cloud host in its own worktree. `cast hibernate` parks an idle session and `cast wake` brings it back, an optional fleet cap bounds each machine, and sessions move between laptop and cloud in bulk. Deep dive: [Remote and cloud sessions](https://codecast.sh/documentation/remote-and-cloud-sessions).
- **`cast browser` moves into your Chrome** (Sep 2 to 18). Once the extension is paired, agents work in a background tab of your own Chrome, inside a `Cast` tab group, with your logins. An agent can offer a page as a pane beside the conversation. Deep dive: [cast browser](https://codecast.sh/documentation/browser).
- **`cast computer`** (Sep 7). Reads one window of a macOS app as an indexed accessibility tree, acts on one element, and reports whether the change was read back. Password managers are refused. Deep dive: [cast computer](https://codecast.sh/documentation/computer).
- **Decisions become documents** (Sep 13 to 15). Each decision has its own page. Related decisions group into a stack with an order and a deadline, and an option can carry its own page. Deep dive: [Decisions](https://codecast.sh/documentation/decisions).
- **One window syncs, the rest replicate** (Sep 1 to 3). One elected window holds the subscriptions and writes the cache; the others apply its stream. One access rule governs both the sync log and direct queries. Deep dive: [How the client syncs](https://codecast.sh/documentation/sync-engine).
- **Limits pause a session** (Sep 1 to 18). Run a session on any saved Claude account, recover a parked session on the account with the most headroom, and switch a session's agent or model in place. `cast handoff --to` starts a linked session from a brief. Deep dive: [Usage limits](https://codecast.sh/documentation/usage-limits).
- **Skills, agent definitions, and the line** (Sep 13 to 14). 23 `cast-*` skills ship inside the CLI. An agent definition names a client, model, effort, tool policy and prompt. Workflow stations run as sessions, and a task that a role works needs an independent review to close. Deep dives: [Skills](https://codecast.sh/documentation/skills) · [Workflows](https://codecast.sh/documentation/workflows).
- **`cast check`, and a steadier daemon** (Sep 4 to 18). One shared `tsc --watch` for each tree answers every session's typecheck. The daemon moved heavy work to workers and gained a watchdog. Deep dive: [cast check](https://codecast.sh/documentation/typecheck).
- **Triggers you can edit and gate** (Sep 1 to 7). `cast trigger update` edits in place with a version history, `--precheck` skips a run that has nothing to do, and every trigger has a detail page. Deep dive: [Triggers](https://codecast.sh/documentation/triggers).
- **Chat reaches Slack, roles and sessions** (Sep 13 to 18). Mention a role or a session and it answers in the thread. A Slack workspace mirrors into team chat. Agents can sit in a huddle. Deep dives: [Team chat](https://codecast.sh/documentation/team-chat) · [Huddles and walkie](https://codecast.sh/documentation/calls).
- **Session characters and follow mode** (Sep 13 to 17). Every session wears one of 24 painted faces and a short name. Follow a teammate's view, and see who reads a conversation with you.
- **Notifications and mobile** (Sep 1 to 19). Sessions that need input fold into one digest. An iOS Live Activity shows every live session on the lock screen. Mobile gets dark mode and chat as a top level tab.
- **A calmer interface** (Sep 1 to 19). A minimal interface style, side by side as a tab split you drag into, `ctrl+tab` over recent objects, and chat and work as their own desktop windows.

## August 2026: Decisions, a browser for agents, and a team that talks
**v1.1.95 – v1.1.113 · Desktop v1.1.98**

This month agents learned to ask. `cast decide` puts a question in a queue you
clear in your own time, and a pinned state line says where each thread stands
before you open it. Agents got a browser, a terminal you can watch from another
machine, and images that render in the thread. Teams got chat, huddles with
transcripts, and push to talk.

- **`cast decide`: a queue for decisions** (Aug 14 to 27). One question with its options, what each costs, and the reasoning, in a queue you clear in one sitting. The answer returns as a message. Permission prompts appear in the same queue. Deep dive: [Decisions](https://codecast.sh/documentation/decisions).
- **Pinned state, and an inbox that says who acts next** (Aug 4 to 17). `cast state` pins where a thread stands, with its staleness on show. A finished turn settles as Done or Dormant as well as Needs Input. Deep dive: [Pinned thread state](https://codecast.sh/documentation/thread-state).
- **`cast browser`: a browser for agents** (Aug 12 to 26). One tab for each session, a snapshot then an action on a ref, `do` for several steps in one process, and a live view you can take control from. Deep dive: [cast browser](https://codecast.sh/documentation/browser).
- **Terminals on any machine** (Aug 2 to 13). A terminal for each conversation. Watch a tmux pane on another machine and type into it over one leased stream. `cast resume --tmux` attaches to a session's pane. Deep dive: [Remote and cloud sessions](https://codecast.sh/documentation/remote-and-cloud-sessions).
- **Team chat** (Aug 12 to 30). Channels, direct messages, threads and a threads inbox. Ids render as live references, and a reply on a session's thread is relayed into the session. Deep dive: [Team chat](https://codecast.sh/documentation/team-chat).
- **Huddles and walkie** (Aug 14 to 28). Every huddle is transcribed with exact speaker attribution and leaves a digest. Walkie is push to talk with a teammate's face as the key. `cast calls` lets an agent read what was said. Deep dive: [Huddles and walkie](https://codecast.sh/documentation/calls).
- **Images in the thread** (Aug 8 to 13). `cast image` turns a screenshot into a link that renders inline. A gallery for each session, thumbnails in the inbox, and images a shell command wrote.
- **Tasks: subtasks, statuses and projects** (Aug 5 to 25). Subtasks with a close guard, task statuses for each team, `cast project`, label grouping, and a progress chart on every project. Deep dive: [Tasks and plans](https://codecast.sh/documentation/tasks-and-plans).
- **The workbench** (Aug 2 to 27). Open a session beside a task, doc or plan; peek and pin; saved views, layouts and context menus; a command palette that covers every feature; detached windows on desktop.
- **Files** (Aug 1 to 21). Vault is now Files: your markdown directories, served by the daemon, with live preview editing, daily notes and `cast vault` from the terminal. The files stay on your machine.
- **Pages and canvas** (Aug 2 to 27). Artifacts are now pages, managed from the CLI, and they embed in conversations. The canvas gained tabs, sortable tables, tooltips and charts. Deep dives: [Published pages](https://codecast.sh/documentation/publish) · [The visual canvas](https://codecast.sh/documentation/visual-canvas).
- **More agents, more machines** (Aug 3 to 26). Grok Build as a client, Windows through WSL, one command from nothing to synced, a default model for each agent client, `cast usage`, and a capabilities page that shows drift across machines. Deep dive: [Usage limits](https://codecast.sh/documentation/usage-limits).
- **Sync you can see, and a lighter client** (Aug 2 to 28). An append only sync log for each scope, heartbeat fields moved off the session rows, and more surfaces painting from the local store. Deep dive: [How the client syncs](https://codecast.sh/documentation/sync-engine).
- **Notifications and security** (Aug 2 to 17). Push routing that knows where you are, API tokens bound to their device, email verification, reads across tenants closed, and a kill that is final.

## July 2026: Triggers, more agents, and published pages
**v1.1.72 – v1.1.94 · Desktop v1.1.88**

This month codecast grew beyond a single agent. OpenCode and pi joined Claude
Code, Codex, Cursor, and Gemini as first-class clients. Triggers run follow-up
work on a timer or a GitHub event and live in the inbox like sessions do. And
`cast publish` turns any HTML file into a public page with a stable link.

- **Triggers.** `cast trigger add` schedules follow-up work: once, on an interval, or on a GitHub event. Triggers live in the inbox, each run linked to its conversation, with browseable run history. Markdown prompts; `--safe` makes a run read-only. Deep dive: [Triggers](https://codecast.sh/documentation/triggers).
- **OpenCode, pi, and Cursor.** OpenCode and pi record, resume, and fork as first-class clients; Cursor resumes through its own resume path. A client registry makes the next agent cheap to add.
- **`cast publish`.** Any HTML file becomes a public page at a stable URL; republishing the same file updates the same link. Branded pages with link previews, cached at the edge. Deep dive: [Published pages](https://codecast.sh/documentation/publish).
- **Owners, machines, and provider keys.** Sessions have owners separate from who started them; agent-run sessions land in a human's inbox. One control assigns owners and machine; moved sessions carry their uncommitted work. Store a provider API key once and codecast injects it at launch on any device.
- **The inbox, team-wide.** Team mode shows every team-visible session on one board. Needs-input push notifications now come from the server, so your phone buzzes when a session actually waits on you.
- **Mobile catches up.** Model and effort switcher, new-session sheet parity with web compose, inbox stash and kill buckets, canvas rendering, JetBrains Mono app-wide.
- **Hardened and faster.** The daemon survives macOS sleep; device identity binds to hardware so a copied config can't impersonate its source; search falls back to titles on timeout; cross-tenant access holes closed.

## June 2026: Messaging, comments, and cast blame
**v1.1.51 – v1.1.67 · Desktop v1.1.80**

This month we built for teams working together. You can message any session
like a colleague, leave comments on a teammate's work in a side rail, and trace
any line of code back to the conversation that wrote it with `cast blame`.

- **Message any session.** `cast send` reaches any session by its short id, old or active. The messaging snippet teaches this to your agents, so sessions talk to each other — one session hands another a task and acts on the reply — and it routes team-wide, so a session can reach a teammate's session too. Paired with the stable feed, which injects recent team sessions into every new session at start, sessions have ambient awareness of each other: each one boots knowing which sessions exist, what state they are in, and how to reach them. Deep dives: [Messaging between sessions](https://codecast.sh/documentation/messaging) · [Ambient awareness](https://codecast.sh/documentation/ambient-awareness).
- **`cast blame`.** A drop-in `git blame` whose author column is the session, and person, that wrote each line. Jump from a line to the conversation that produced it. Editor plugins for VS Code, Cursor, and vim-fugitive.
- **Review and comments.** Quote and comment on an assistant's reply in a right-hand rail; comments stay visible. Inline comments on diff lines in document review.
- **Organize the inbox.** A Favorites view, manual labels and buckets, and a stash that sets a session aside without stopping its agent.
- **Reading long conversations.** Density modes collapse turns for skimming; large code blocks render faster; scroll holds steady across session switches.
- **Faster and more reliable.** Typing no longer drops frames in big lists; user messages don't get dropped (the send queue re-drives on reconnect); per-message model tracking.

## May 2026: Run sessions on any machine
**v1.1.34 – v1.1.50 · Desktop v1.1.76**

This month codecast started working across machines. Register a laptop, a cloud
VM, or a throwaway sandbox, then send a session to whichever one has the code,
and move a running session between them without losing context. We also spent
the month hardening sync.

- **Devices and remote sessions.** A Devices settings page to register and manage machines; move an active session from laptop to cloud mid-flight; cloud sandbox and Mac-mini backends.
- **Sync that recovers itself.** Status flags conversations that have stopped progressing and can repair them; wedged-terminal detection forces a clean restart; a delivery retry loop lands the message or lets you cancel.
- **Inbox and triage.** Each card shows its terminal session and permission mode; permission-blocked agents show up in Needs Input; task search by query.
- **Performance.** Heavy libraries load on demand and we precompress assets; the conversation view stops remounting on session switch; core data moved into a local-first cache.

## April 2026: Workspaces, windows, and shared documents
**v1.1.21 – v1.1.32 · Desktop v1.1.64**

This month we added structure for bigger work: projects to group sessions,
browser-style tabs, a window manager for working with sessions side by side,
and documents that grew into a small knowledge base.

- **Projects and workspaces.** Group sessions, tasks, and docs by project; switch inline; saved views.
- **Tabs and windows.** A browser-style tab bar with keyboard shortcuts; multi-window support; tabs keep conversation state alive across switches.
- **Documents and sharing.** Wiki-style backlinks and a sidebar tree; public share pages for docs and plans; `cast share` and `cast unshare`.
- **Teams and notifications.** Per-teammate mute controls and notification-type toggles; one comment timeline on plans and docs; team onboarding.
- **Under the hood.** The CLI now encrypts its auth token at rest (AES-256-GCM); a local message cache loads conversations right away; an HTTP hook server pushes agent status the moment it changes; large-display zoom defaults on desktop.

## March 2026: Plans, workflows, and orchestration
**v1.0.48 – v1.1.7 · first 1.1 desktop builds**

Our biggest month so far. We shipped plans and tasks to track multi-session
work, workflows to chain agent steps and human approvals, and orchestration
that runs a plan's tasks in parallel across agents. We rebuilt the web app on
Vite and shipped a collaborative document editor.

- **Plans, tasks, and orchestration.** Plans with goals and acceptance criteria; tasks with priorities and dependencies; orchestration breaks a plan into tasks and runs them in parallel waves across agents, retrying failures. Deep dives: [Tasks and plans](https://codecast.sh/documentation/tasks-and-plans) · [Orchestration](https://codecast.sh/documentation/orchestration).
- **Workflows.** Graph-based templates of agent steps, shell commands, conditional branches, and human approval gates; run from the CLI, palette, or an @mention with live progress. Deep dive: [Workflows](https://codecast.sh/documentation/workflows).
- **The web app, rebuilt on Vite.** Faster builds; a Cmd+K command palette with full-text search; native desktop notifications that click through to a session.
- **Collaborative documents.** A rich editor with @mentions, slash commands, images, and real-time sync; promote a plan body into a doc.
- **Activity, profiles, and subscriptions.** Daily activity feeds with written summaries; profile pages with a 180-day heatmap; watch any entity for notifications.
- **Self-hosted backend.** Moved to self-hosted infrastructure with daily backups, cutting latency and cost.

## February 2026: Mobile, the inbox, and forking
**v1.0.31 – v1.0.45 · first desktop build · Mobile v1.0 (App Store)**

This month we put codecast on more screens. The iOS app caught up to the web
for reading and steering sessions, the first desktop build went out, and we
added the inbox: one place that gathers every session waiting on you.

- **The inbox.** One view of idle and waiting sessions, with defer/dismiss keyboard shortcuts and pinning.
- **Mobile parity.** Full chat rendering on iOS including plans, tasks, and tool calls; camera and photo picker; over-the-air updates.
- **Forking conversations.** Branch a conversation at any message into its own line; a tree panel and branch selector to navigate forks. Deep dive: [Forks and spawned sessions](https://codecast.sh/documentation/forks-and-spawn).
- **The stable feed.** `cast stable` injects a feed of recent sessions into every new session at start, solo or team scoped, so an agent begins already knowing what was just worked on. Deep dive: [Ambient awareness](https://codecast.sh/documentation/ambient-awareness).
- **Desktop debut and more agents.** The first native desktop build with a self-restarting daemon watchdog; Gemini CLI sessions recorded alongside Claude Code, Codex, and Cursor; remote control from the web.

## January 2026: Memory, teams, and reliable sync
**v1.0.2 – v1.0.26**

This month we made past sessions useful. The CLI can search your history,
answer questions about it, and pull up relevant prior work before you start
something new.

- **Agent memory in the CLI.** `cast search` and `cast feed` find past work; `cast ask` answers natural-language questions; `cast context` pulls up relevant prior sessions; `cast handoff` / `summary` / `decisions` carry knowledge forward. Deep dives: [Agent memory](https://codecast.sh/documentation/memory) · [How agent snippets work](https://codecast.sh/documentation/agent-snippets).
- **Teams and sharing.** Belong to multiple teams and switch between them; choose what's visible to teammates down to individual messages; auto-share folders.
- **GitHub integration.** Commits and pull requests flow in through webhooks; each session collects the files it touched and the PRs it produced.
- **Reliable sync.** A ledger tracks every message with hourly reconciliation; a health command finds and repairs gaps; the daemon starts on login and restarts itself if it stalls.

## December 2025: The first release
**v1.0**

This is the first release. We shipped a background daemon that watches your
local session files and streams them to a shared backend as you work, plus a
web dashboard to read them back. It works with Claude Code, Codex, and Cursor
today.

- **The daemon.** Watches Claude Code, Codex, and Cursor session files and syncs them live, with a retry queue. We redact API keys before anything leaves your machine and hash project paths.
- **The web dashboard.** Full conversations with syntax-highlighted code, collapsible tool calls, images, and diffs; global search; shareable links.
- **Foundations.** Email/password accounts, private-by-default conversations with team sharing, project grouping, and a virtualized message list for huge conversations.
- **Built to extend.** A tool registry that renders any agent tool, nested subagent conversations, token-usage tracking, and the warm light theme that sets the look of the app.

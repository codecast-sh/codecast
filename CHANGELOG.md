# Changelog

What we shipped, month by month. Newest first.

The rendered version lives at **[/changelog](https://codecast.sh/changelog)**.
Both this file and the page read from one curated source,
`packages/web/app/(marketing)/changelog/changelogData.ts`. To refresh after a
release, run `node scripts/changelog-mine.mjs <YYYY-MM>` to see what shipped,
then extend that file.

---

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

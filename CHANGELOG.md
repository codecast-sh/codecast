# Changelog

What we shipped, month by month. Newest first.

The rendered version lives at **[/changelog](https://codecast.sh/changelog)**.
Both this file and the page read from one curated source,
`packages/web/app/(marketing)/changelog/changelogData.ts`. To refresh after a
release, run `node scripts/changelog-mine.mjs <YYYY-MM>` to see what shipped,
then extend that file.

---

## June 2026: Messaging, comments, and cast blame
**v1.1.51 – v1.1.67 · Desktop v1.1.80**

This month we built for teams working together. You can message any session
like a colleague, leave comments on a teammate's work in a side rail, and trace
any line of code back to the conversation that wrote it with `cast blame`.

- **Message any session.** `cast send` reaches any session by its short id, old or active. It now routes team-wide, so you can reach a teammate's session too.
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

- **Plans, tasks, and orchestration.** Plans with goals and acceptance criteria; tasks with priorities and dependencies; orchestration breaks a plan into tasks and runs them in parallel waves across agents, retrying failures.
- **Workflows.** Graph-based templates of agent steps, shell commands, conditional branches, and human approval gates; run from the CLI, palette, or an @mention with live progress.
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
- **Forking conversations.** Branch a conversation at any message into its own line; a tree panel and branch selector to navigate forks.
- **Desktop debut and more agents.** The first native desktop build with a self-restarting daemon watchdog; Gemini CLI sessions recorded alongside Claude Code, Codex, and Cursor; remote control from the web.

## January 2026: Memory, teams, and reliable sync
**v1.0.2 – v1.0.26**

This month we made past sessions useful. The CLI can search your history,
answer questions about it, and pull up relevant prior work before you start
something new.

- **Agent memory in the CLI.** `cast search` and `cast feed` find past work; `cast ask` answers natural-language questions; `cast context` pulls up relevant prior sessions; `cast handoff` / `summary` / `decisions` carry knowledge forward.
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

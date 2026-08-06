// Codecast changelog — what we shipped, month by month.
//
// This is the editorial layer. It is *grounded in* the git history (see
// `scripts/changelog-mine.mjs`, which surfaces each month's release boundaries
// and clustered feature commits as raw material), but the wording is written
// for a reader who doesn't live in the codebase. Raw commit subjects make poor
// changelog prose, so we curate rather than auto-generate.
//
// Voice: write each entry as if we published it that month — "this month we
// shipped X" — not as a retrospective arc. Say what changed and what it does
// for the reader. No grandstanding, no adverbs, no em-dashes.
//
// To update after a release: run `node scripts/changelog-mine.mjs <YYYY-MM>`,
// read what shipped, then extend the matching month here (or add a new one at
// the top). Keep entries newest-first; the page and the root CHANGELOG.md both
// read from this single source.

/** Solarized accent keys — map to the marketing palette in the page renderer. */
export type Accent =
  | "blue"
  | "cyan"
  | "green"
  | "violet"
  | "yellow"
  | "orange"
  | "magenta"
  | "red";

/**
 * Section icon — stored as a lucide-react component *name* so this data module
 * stays plain (no React imports). The page resolves the name to a component.
 * Add a name here and to the ICONS map in page.tsx to use a new one.
 */
export type SectionIcon =
  | "Send"
  | "Fingerprint"
  | "Quote"
  | "Star"
  | "BookOpen"
  | "Gauge"
  | "MonitorSmartphone"
  | "RefreshCw"
  | "ListFilter"
  | "FolderKanban"
  | "AppWindow"
  | "Share2"
  | "Users"
  | "Wrench"
  | "ListChecks"
  | "Workflow"
  | "Globe"
  | "FileText"
  | "Activity"
  | "Server"
  | "Inbox"
  | "Smartphone"
  | "GitBranch"
  | "Monitor"
  | "Brain"
  | "Github"
  | "Cpu"
  | "LayoutDashboard"
  | "Boxes"
  | "Puzzle"
  | "Clock";

export interface ChangeSection {
  /** Short topical heading, e.g. "Agent memory in the CLI". */
  title: string;
  /** Accent color for the section's icon tile and bullet ticks. */
  accent: Accent;
  /** Icon shown in the accent tile. */
  icon: SectionIcon;
  /** Plain-language highlights — what changed and what it does. */
  items: string[];
  /** Deep dive guides for this feature (rendered as footer links on the card). */
  docs?: { href: string; label: string }[];
}

export interface Release {
  /** Stable anchor slug, e.g. "2026-06". */
  id: string;
  /** Display month, e.g. "June 2026". */
  month: string;
  /** ISO date used only for ordering (first of the month is fine). */
  sortDate: string;
  /** Primary CLI version or range shipped in the period. */
  version: string;
  /** Desktop build, when one shipped and is worth surfacing. */
  desktop?: string;
  /** Optional badge, e.g. "Latest" or "First release". */
  tag?: string;
  /** One-line topic label for the month. */
  headline: string;
  /** 2–4 sentence note, written as of that month. */
  summary: string;
  sections: ChangeSection[];
}

/** Newest first. The first entry is treated as the current release. */
export const RELEASES: Release[] = [
  {
    id: "2026-07",
    month: "July 2026",
    sortDate: "2026-07-01",
    version: "v1.1.72 – v1.1.94",
    desktop: "Desktop v1.1.88",
    tag: "Latest",
    headline: "Triggers, more agents, and published pages",
    summary:
      "This month codecast grew beyond a single agent. OpenCode and pi joined Claude Code, Codex, Cursor, and Gemini as first-class clients, with resume and forking to match. Triggers run follow-up work on a timer or a GitHub event and live in the inbox like sessions do. And `cast publish` turns any HTML file into a public page with a stable link.",
    sections: [
      {
        title: "Triggers: work that runs later",
        accent: "blue",
        icon: "Clock",
        items: [
          "`cast trigger add` schedules follow-up work: once in 30 minutes, on a recurring interval, or when a GitHub event such as a PR comment lands.",
          "Triggers live in the inbox next to your sessions. Each run links to the conversation it spawned, with a browseable run history on every surface.",
          "Prompts are markdown, so a trigger can carry a full brief with goals and steps. `--safe` makes a run read-only.",
          "Killing a session cancels its triggers; restoring the session re-arms them.",
        ],
        docs: [{ href: "/documentation/triggers", label: "Triggers" }],
      },
      {
        title: "OpenCode, pi, and Cursor",
        accent: "violet",
        icon: "Boxes",
        items: [
          "OpenCode and pi sessions record, resume, and fork like Claude Code and Codex ones, with thinking, images, and tool calls all rendered in place.",
          "Cursor sessions resume through the agent's own resume path instead of restarting from scratch.",
          "A client registry describes each agent once, so the next one is cheap to add. Failed turns surface as classified error banners instead of silent stalls.",
          "Subagents nest under the session that spawned them, whichever client is running.",
        ],
      },
      {
        title: "cast publish: pages from your terminal",
        accent: "cyan",
        icon: "Globe",
        items: [
          "`cast publish report.html` gives any HTML file a public page at a stable URL. Republishing the same file updates the same link.",
          "Pages serve as branded documents with link previews, cached at the edge so they load fast anywhere.",
        ],
        docs: [{ href: "/documentation/publish", label: "Published pages" }],
      },
      {
        title: "Owners, machines, and provider keys",
        accent: "green",
        icon: "Users",
        items: [
          "Sessions now have owners separate from who started them. An agent-run session lands in a human's inbox, and a session can belong to several owners at once.",
          "One header control assigns owners and the machine together, and `cast spawn --device` starts work on a specific machine.",
          "A session moved between machines carries its uncommitted work along and posts a note about the checkout it woke up on.",
          "Store a provider API key once and codecast injects it at launch on any of your devices, encrypted in transit and at rest.",
        ],
      },
      {
        title: "The inbox, team-wide",
        accent: "yellow",
        icon: "Inbox",
        items: [
          "Team mode shows every team-visible session on one board; keyboard navigation and the command palette follow the scope you are in.",
          "Needs-input push notifications now come from the server, so your phone buzzes when a session waits on you and not before.",
          "Session cards show which agent client is running, and questions with multiple answers render as real checkboxes.",
        ],
      },
      {
        title: "Mobile catches up",
        accent: "magenta",
        icon: "Smartphone",
        items: [
          "A model and effort switcher in the session header, and a new-session sheet that matches web compose, machine picker included.",
          "Inbox parity with the web sidebar: stash and kill buckets, project chips, and collapsible sections.",
          "Canvas and full-message HTML rendering, and JetBrains Mono app-wide to match the web.",
        ],
      },
      {
        title: "Hardened and faster",
        accent: "orange",
        icon: "Gauge",
        items: [
          "The daemon survives macOS sleep: the file watcher restarts if it goes deaf, and the watchdog no longer kills a healthy daemon on wake.",
          "Device identity binds to the hardware, so a copied config directory can't impersonate its source machine.",
          "Search falls back to title matches when content search times out, instead of returning nothing.",
          "We closed unauthenticated cross-tenant access holes and cut hot-path query load across the backend.",
        ],
      },
    ],
  },
  {
    id: "2026-06",
    month: "June 2026",
    sortDate: "2026-06-01",
    version: "v1.1.51 – v1.1.67",
    desktop: "Desktop v1.1.80",
    headline: "Messaging, comments, and cast blame",
    summary:
      "This month we built for teams working together. You can message any session like a colleague, leave comments on a teammate's work in a side rail, and trace any line of code back to the conversation that wrote it with `cast blame`. The inbox can favorite and file sessions, and the conversation viewer got density controls for skimming long histories.",
    sections: [
      {
        title: "Message any session",
        accent: "blue",
        icon: "Send",
        items: [
          "`cast send` reaches any session by its short id, old or active. A dormant session wakes up with full context and runs what you ask; a live one gets your note as a new turn.",
          "The messaging snippet teaches this to your agents, so sessions talk to each other: one session hands another a task, asks it to report back, and acts on the reply.",
          "Messaging routes team-wide. A session can message a teammate's session, with the sender's name on the message.",
          "Paired with the stable feed, which injects recent team sessions into every new session at start, sessions have ambient awareness of each other: each one boots knowing which sessions exist, what state they are in, and how to reach them.",
        ],
        docs: [
          { href: "/documentation/messaging", label: "Messaging between sessions" },
          { href: "/documentation/ambient-awareness", label: "Ambient awareness" },
        ],
      },
      {
        title: "cast blame: code that knows its origin",
        accent: "cyan",
        icon: "Fingerprint",
        items: [
          "A drop-in replacement for `git blame` whose author column is the session, and person, that wrote each line.",
          "Jump from any line to the conversation that produced it, scrolled to the exact edit.",
          "Editor plugins for VS Code, Cursor, and vim-fugitive bring this inline, with a session log for any file.",
        ],
      },
      {
        title: "Review and comments",
        accent: "violet",
        icon: "Quote",
        items: [
          "Quote and comment on an assistant's reply in a right-hand rail; comments stay visible instead of hiding behind a hover.",
          "Document review mode adds comments on individual diff lines.",
          "A single message toolbar gathers quote, comment, copy, and thread actions in one place.",
        ],
      },
      {
        title: "Organize the inbox",
        accent: "green",
        icon: "Star",
        items: [
          "A Favorites view pins the sessions you keep coming back to at the top.",
          "Manual labels and buckets let you file work under your own categories, in the app and from the CLI.",
          "Stash sets a session aside without stopping its agent, separate from killing it outright.",
        ],
      },
      {
        title: "Reading long conversations",
        accent: "yellow",
        icon: "BookOpen",
        items: [
          "Density modes (condensed, compact, and a summary view) collapse turns so you can skim a long session.",
          "Large code blocks render faster, and scroll position holds steady when you switch sessions.",
          "The command palette now searches across tasks, docs, and plans, not only sessions.",
        ],
      },
      {
        title: "Faster and more reliable",
        accent: "orange",
        icon: "Gauge",
        items: [
          "Typing no longer drops frames in big session lists; the list is virtualized and view switches are deferred.",
          "User messages don't get dropped; the send queue re-drives on reconnect, focus, and a timer.",
          "Each message now records the model that produced it, and we cache agent status for faster loads.",
        ],
      },
    ],
  },
  {
    id: "2026-05",
    month: "May 2026",
    sortDate: "2026-05-01",
    version: "v1.1.34 – v1.1.50",
    desktop: "Desktop v1.1.76",
    headline: "Run sessions on any machine",
    summary:
      "This month codecast started working across machines. Register a laptop, a cloud VM, or a throwaway sandbox, then send a session to whichever one has the code. You can move a running session between machines without losing context. We also spent the month hardening sync: catching stuck conversations, recovering wedged terminals, and making sure messages land.",
    sections: [
      {
        title: "Devices and remote sessions",
        accent: "blue",
        icon: "MonitorSmartphone",
        items: [
          "A Devices settings page registers and manages your machines: Macs, cloud VMs, and on-demand sandboxes.",
          "Move an active session from your laptop to the cloud, or between regions, mid-flight and without losing context.",
          "The CLI runs an HTTP control server so the web dashboard can start, resume, and steer sessions on a remote machine.",
        ],
      },
      {
        title: "Sync that recovers itself",
        accent: "cyan",
        icon: "RefreshCw",
        items: [
          "`cast status` flags conversations that have stopped progressing, with a repair path to recover them.",
          "Wedged-terminal detection forces a clean restart instead of retrying a dead session forever.",
          "A delivery retry loop either lands your message or gives you a clear way to cancel, with no silent limbo.",
          "Image-heavy conversations offload their images before syncing, so they stop getting stuck.",
        ],
      },
      {
        title: "Inbox and triage",
        accent: "green",
        icon: "ListFilter",
        items: [
          "Each session card shows its terminal session and permission mode, so you can see why something is idle or waiting.",
          "Permission-blocked agents show up in Needs Input instead of going unnoticed.",
          "Task lists take a query filter for searching, and a new session links to its task as it's created.",
        ],
      },
      {
        title: "Performance",
        accent: "orange",
        icon: "Gauge",
        items: [
          "Heavy libraries for diagrams, math, and graph rendering now load on demand, and we precompress assets, so pages load faster.",
          "The conversation view no longer remounts when you switch sessions.",
          "Your account, teams, members, favorites, and bookmarks moved into a local-first cache to cut re-fetches.",
        ],
      },
    ],
  },
  {
    id: "2026-04",
    month: "April 2026",
    sortDate: "2026-04-01",
    version: "v1.1.21 – v1.1.32",
    desktop: "Desktop v1.1.64",
    headline: "Workspaces, windows, and shared documents",
    summary:
      "This month we added structure for bigger work. Group sessions, tasks, and docs into projects, open them in browser-style tabs, and tile several sessions side by side with the new window manager. Documents got wiki-style backlinks and public share pages. The CLI now encrypts the token it keeps on disk.",
    sections: [
      {
        title: "Projects and workspaces",
        accent: "blue",
        icon: "FolderKanban",
        items: [
          "Group sessions, tasks, and documents by project, and switch between projects inline.",
          "Saved views remember a project-scoped slice of your work so you can return to it in one click.",
          "Project detail pages show repositories, team suggestions, and recent activity.",
        ],
      },
      {
        title: "Tabs and windows",
        accent: "violet",
        icon: "AppWindow",
        items: [
          "A browser-style tab bar with keyboard shortcuts to open a session in a new tab, close it, and move between them.",
          "A window manager brings multi-window support, so you can tile sessions side by side.",
          "Tabs keep their conversation state alive when you switch away, instead of reloading from scratch.",
        ],
      },
      {
        title: "Documents and sharing",
        accent: "cyan",
        icon: "Share2",
        items: [
          "Wiki-style backlinks and a sidebar tree turn documents into a navigable knowledge base.",
          "Public share pages for documents and plans, with canonical URLs and copy-link buttons.",
          "`cast share` and `cast unshare` publish a doc or plan to a public link from the terminal.",
        ],
      },
      {
        title: "Teams and notifications",
        accent: "green",
        icon: "Users",
        items: [
          "Per-teammate mute controls and notification-type toggles, so you only hear about what matters.",
          "A single comment timeline on plans and docs, with delivery state for each message.",
          "Team onboarding suggests repositories to connect and walks new members through setup.",
        ],
      },
      {
        title: "Under the hood",
        accent: "orange",
        icon: "Wrench",
        items: [
          "The CLI now encrypts its auth token at rest with AES-256-GCM.",
          "A local message cache loads conversations right away while fresh data syncs in the background.",
          "An HTTP hook server pushes agent status to the web the moment it changes.",
          "Desktop detects large and ultrawide displays and picks a sensible zoom level.",
        ],
      },
    ],
  },
  {
    id: "2026-03",
    month: "March 2026",
    sortDate: "2026-03-01",
    version: "v1.0.48 – v1.1.7",
    desktop: "First 1.1 desktop builds",
    headline: "Plans, workflows, and orchestration",
    summary:
      "Our biggest month so far. We shipped plans and tasks to track multi-session work, workflows to chain agent steps and human approvals, and orchestration that runs a plan's tasks in parallel across agents. We rebuilt the web app on Vite, added a Cmd+K command palette, and shipped a collaborative document editor.",
    sections: [
      {
        title: "Plans, tasks, and orchestration",
        accent: "blue",
        icon: "ListChecks",
        items: [
          "Plans capture multi-session features with goals and acceptance criteria; tasks carry priorities, status, and dependencies.",
          "Orchestration breaks a plan into independent tasks and runs them in parallel waves across agents.",
          "Failed tasks retry on their own with escalation logging; a dashboard shows what's in flight, blocked, or done.",
          "The daemon links plans and tasks it sees referenced in conversations, so you don't track them by hand.",
        ],
        docs: [
          { href: "/documentation/tasks-and-plans", label: "Tasks and plans" },
          { href: "/documentation/orchestration", label: "Orchestration" },
        ],
      },
      {
        title: "Workflows",
        accent: "violet",
        icon: "Workflow",
        items: [
          "Graph-based templates that chain agent steps, shell commands, conditional branches, and human approval gates.",
          "Run a workflow from the CLI, the command palette, or an @mention, with live progress in the dashboard.",
          "Human gates pause and notify you; your reply flows into the next step's context.",
        ],
        docs: [{ href: "/documentation/workflows", label: "Workflows" }],
      },
      {
        title: "The web app, rebuilt on Vite",
        accent: "cyan",
        icon: "Globe",
        items: [
          "Moved off Next.js to Vite for faster builds and a cleaner desktop integration.",
          "A Cmd+K command palette with full-text search across sessions, tasks, plans, and documents.",
          "Native desktop notifications that click through to the session they're about.",
        ],
      },
      {
        title: "Collaborative documents",
        accent: "green",
        icon: "FileText",
        items: [
          "A rich editor with @mentions, slash commands, images, and real-time multi-user sync.",
          "Mention any session, task, plan, or doc inline and expand it into the page.",
          "Promote a plan's body into a standalone document.",
        ],
      },
      {
        title: "Activity, profiles, and subscriptions",
        accent: "yellow",
        icon: "Activity",
        items: [
          "Daily activity feeds with written summaries of what happened, grouped by project.",
          "Profile pages with a 180-day activity heatmap and a timeline of your work.",
          "Watch any session, plan, doc, or task and get notified when a teammate touches it.",
        ],
      },
      {
        title: "Self-hosted backend",
        accent: "orange",
        icon: "Server",
        items: [
          "Moved the backend to self-hosted infrastructure with daily backups, cutting latency and cost.",
          "Routed data access through one team-scoping layer to prevent cross-team leaks.",
        ],
      },
    ],
  },
  {
    id: "2026-02",
    month: "February 2026",
    sortDate: "2026-02-01",
    version: "v1.0.31 – v1.0.45",
    desktop: "First desktop build · Mobile v1.0 (App Store)",
    headline: "Mobile, the inbox, and forking",
    summary:
      "This month we put codecast on more screens. The iOS app caught up to the web for reading and steering sessions, and the first desktop build went out. We added the inbox, one place that gathers every session waiting on you. Conversations can now branch, so you can try a different path without losing the original.",
    sections: [
      {
        title: "The inbox",
        accent: "blue",
        icon: "Inbox",
        items: [
          "One view of every idle and waiting session, ordered so the ones needing your input come first.",
          "Defer and dismiss states with keyboard shortcuts to move through a queue quickly.",
          "Pin important sessions so they stay reachable no matter how busy things get.",
        ],
      },
      {
        title: "Mobile parity",
        accent: "magenta",
        icon: "Smartphone",
        items: [
          "Full chat rendering on iOS, including plans, tasks, skills, and tool calls.",
          "Camera and photo picker, and jump-to-end navigation that matches the web.",
          "Over-the-air updates ship fixes without waiting on an App Store review.",
        ],
      },
      {
        title: "Forking conversations",
        accent: "violet",
        icon: "GitBranch",
        items: [
          "Branch a conversation at any message into its own line, without touching the original.",
          "A tree panel and branch selector let you navigate between forks.",
          "Resume a branch as a fresh agent run, carrying the history up to the fork point.",
        ],
        docs: [{ href: "/documentation/forks-and-spawn", label: "Forks and spawned sessions" }],
      },
      {
        title: "Desktop debut and more agents",
        accent: "cyan",
        icon: "Monitor",
        items: [
          "The first native desktop build, with a watchdog that keeps the daemon alive and restarts it on crash.",
          "Gemini CLI sessions now record alongside Claude Code, Codex, and Cursor.",
          "Remote commands let the web start, resume, kill, and switch sessions on your machine.",
        ],
      },
    ],
  },
  {
    id: "2026-01",
    month: "January 2026",
    sortDate: "2026-01-01",
    version: "v1.0.2 – v1.0.26",
    headline: "Memory, teams, and reliable sync",
    summary:
      "This month we made past sessions useful. The CLI can search your whole history, answer questions about it, and pull up relevant prior work before you start something new. We added team sharing controls down to the individual message. GitHub commits and pull requests now flow into each session.",
    sections: [
      {
        title: "Agent memory in the CLI",
        accent: "blue",
        icon: "Brain",
        items: [
          "`cast search` and `cast feed` find past work; `cast ask` answers natural-language questions over your whole history.",
          "`cast context` pulls up the relevant prior sessions before you start something new.",
          "`cast handoff`, `cast summary`, and `cast decisions` carry knowledge forward between sessions.",
        ],
        docs: [
          { href: "/documentation/memory", label: "Agent memory" },
          { href: "/documentation/agent-snippets", label: "How agent snippets work" },
        ],
      },
      {
        title: "Teams and sharing",
        accent: "green",
        icon: "Users",
        items: [
          "Belong to multiple teams and switch between them.",
          "Choose what's visible to teammates, down to individual messages, plus auto-share folders.",
          "Team profile pages, avatars, and live presence show who's active.",
        ],
      },
      {
        title: "GitHub integration",
        accent: "violet",
        icon: "Github",
        items: [
          "Commits and pull requests flow in through webhooks in real time.",
          "Each session collects the files it touched and the PRs it produced.",
          "Per-repository scope lets teams choose which repos feed into codecast.",
        ],
      },
      {
        title: "Reliable sync",
        accent: "orange",
        icon: "RefreshCw",
        items: [
          "A ledger tracks every message, with hourly reconciliation between your machine and the server.",
          "A health command finds and repairs gaps before they become missing history.",
          "The daemon starts on login and restarts itself if it stalls.",
        ],
      },
    ],
  },
  {
    id: "2025-12",
    month: "December 2025",
    sortDate: "2025-12-01",
    version: "v1.0",
    tag: "First release",
    headline: "The first release",
    summary:
      "This is the first release. We shipped a background daemon that watches your local session files and streams them to a shared backend as you work, plus a web dashboard to read them back. It works with Claude Code, Codex, and Cursor today.",
    sections: [
      {
        title: "The daemon",
        accent: "blue",
        icon: "Cpu",
        items: [
          "A background service that watches Claude Code, Codex, and Cursor session files and syncs them live.",
          "A retry queue survives flaky connections so nothing is lost.",
          "We redact API keys before anything leaves your machine, and hash project paths.",
        ],
      },
      {
        title: "The web dashboard",
        accent: "cyan",
        icon: "LayoutDashboard",
        items: [
          "Read full conversations with syntax-highlighted code, collapsible tool calls, images, and diffs.",
          "Global search with instant filtering and highlighted snippets.",
          "Shareable links to any conversation.",
        ],
      },
      {
        title: "Foundations",
        accent: "green",
        icon: "Boxes",
        items: [
          "Email and password accounts with protected routes.",
          "Private-by-default conversations, with team sharing when you want it.",
          "Project-based grouping and a virtualized message list that keeps even huge conversations fast.",
        ],
      },
      {
        title: "Built to extend",
        accent: "violet",
        icon: "Puzzle",
        items: [
          "A tool registry that can render any agent tool, with subagent conversations nested under their parent.",
          "Token-usage tracking, and the warm light theme that sets the look of the app.",
        ],
      },
    ],
  },
];

/** Convenience: the most recent release. */
export const LATEST_RELEASE = RELEASES[0];

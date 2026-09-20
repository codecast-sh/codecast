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
  | "Clock"
  | "Scale"
  | "Chrome"
  | "MousePointerClick"
  | "MessagesSquare"
  | "Phone"
  | "Terminal"
  | "Image"
  | "Network"
  | "GitPullRequest"
  | "Cloud"
  | "Bell"
  | "ShieldCheck"
  | "Sparkles"
  | "FolderOpen"
  | "Hourglass"
  | "Pin";

export interface ChangeSection {
  /** Short topical heading, e.g. "Agent memory in the CLI". */
  title: string;
  /** Accent color for the section's icon tile and bullet ticks. */
  accent: Accent;
  /** Icon shown in the accent tile. */
  icon: SectionIcon;
  /**
   * When the section's features reached users, from the commit dates on main,
   * e.g. "Aug 12 to 14". Shown under the title. Older months leave it unset.
   */
  when?: string;
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
    id: "2026-09",
    month: "September 2026",
    sortDate: "2026-09-01",
    version: "v1.1.114 – v1.1.143",
    desktop: "Desktop v1.1.112",
    tag: "Latest",
    headline: "The org, pull requests, and sessions in the cloud",
    summary:
      "This month codecast got a shape for standing work. A role sits in an org tree and holds a responsibility after any one session ends, so a task or a mention goes to the role and not to whoever happens to be running. Pull requests and issues became objects that a session owns and answers. Sessions start on a cloud host with one flag, idle ones hibernate, and `cast browser` moved into your own Chrome.",
    sections: [
      {
        title: "The org: roles that outlive sessions",
        accent: "violet",
        icon: "Network",
        when: "Sep 13 to 18",
        items: [
          "A role is a seat in an org tree with a scope, a standing brief and a standing session. The session ends and the role stays, so work routes to the responsibility.",
          "Assign a task to a role, or mention its handle in team chat, and the role's session wakes to act on it.",
          "`cast org init` reads the code and your sessions before it proposes seats. You edit the proposal in plain words, then accept it. Templates hire a common role in one step.",
          "The org page draws people and agents in one tree. Each scope page shows the role's brief, its tasks and its recent sessions.",
        ],
        docs: [{ href: "/documentation/org-roles", label: "The org" }],
      },
      {
        title: "Pull requests and issues join the board",
        accent: "blue",
        icon: "GitPullRequest",
        when: "Sep 4 to 14",
        items: [
          "A pull request is now a codecast object. It carries its checks, its reviews and open threads, and the session that owns it until it merges.",
          "`cast pr shepherd on` binds a session to a pull request. A review, a failing check or a merge conflict wakes it, and a submitted review arrives as one message.",
          "Review from the shell: hold a note on each line with `cast pr comment --hold`, then send the batch as one review with one verdict.",
          "Linear teams and GitHub repos import as projects, and their issues become tasks. The sync runs both ways: a task comment posts to the issue, and `cast task done` closes it.",
          "A Code page browses repository files, commits and pull requests, and git and issue events appear in project timelines.",
        ],
        docs: [{ href: "/documentation/pull-requests", label: "Pull requests and issues" }],
      },
      {
        title: "Cloud sessions and a fleet that sleeps",
        accent: "cyan",
        icon: "Cloud",
        when: "Sep 4 to 17",
        items: [
          "`cast spawn --cloud` starts a session on a cloud host in its own worktree, with your local agent settings mirrored to the host.",
          "`cast hibernate` parks an idle session and `cast wake` brings it back. An optional fleet cap and idle bar do the same for a whole machine.",
          "Select several inbox cards to move sessions between your laptop and the cloud in bulk. The transcript marks the point where a session changed machine.",
          "A trigger bound to a cloud host wakes the host before it runs.",
        ],
        docs: [{ href: "/documentation/remote-and-cloud-sessions", label: "Remote and cloud sessions" }],
      },
      {
        title: "cast browser moves into your Chrome",
        accent: "orange",
        icon: "Chrome",
        when: "Sep 2 to 18",
        items: [
          "Once the codecast extension is paired, `cast browser` drives your own Chrome and uses the logins you already have. A separate agent browser needs your explicit permission.",
          "Each session owns one background tab inside a `Cast` tab group, with a colored frame and a pointer that follows the agent's mouse.",
          "An agent can offer a page as a pane beside the conversation with `cast browser pane`. The desktop app shows pages that refuse to be framed in a native pane.",
          "A failing step prints console errors, failed requests and a screenshot into the thread, and a step that runs long says what it waits on.",
        ],
        docs: [{ href: "/documentation/browser", label: "cast browser" }],
      },
      {
        title: "cast computer: native Mac apps",
        accent: "magenta",
        icon: "MousePointerClick",
        when: "Sep 7",
        items: [
          "`cast computer` reads one window of a macOS app as an indexed accessibility tree and acts on one element by its index.",
          "Every action reports whether the change was read back. Exit 0 means the action was delivered; `verified` means the app took it.",
          "`set-value` and a press on an element work on a window in the background, so the agent takes nothing from your screen. No verb raises a window unless you pass `--restore-window`.",
          "Password managers are refused, secure fields render as `[redacted]`, and secrets arrive on stdin so they stay out of shell history.",
        ],
        docs: [{ href: "/documentation/computer", label: "cast computer" }],
      },
      {
        title: "Decisions become documents",
        accent: "yellow",
        icon: "Scale",
        when: "Sep 13 to 15",
        items: [
          "Each decision is now a document with its own page, so it has a link, a history and a place in search.",
          "Related decisions group into a stack that you clear in one sitting. `cast stack reorder` orders it and `cast stack policy --due` gives it a deadline; overdue stacks sort first.",
          "An option can carry its own page with `--option-page`, for a choice that needs a mockup or a report to judge.",
          "The card names the session that asked and where it works, and the server says who may grant the request.",
        ],
        docs: [{ href: "/documentation/decisions", label: "Decisions" }],
      },
      {
        title: "One window syncs, the rest replicate",
        accent: "green",
        icon: "RefreshCw",
        when: "Sep 1 to 3",
        items: [
          "With several windows open, exactly one is elected the sync host. It holds the subscriptions and writes the local cache, and the other windows apply its stream.",
          "Rows from the sync log apply straight into the store. One access rule decides both who receives a row in the log and who may read it in a direct query, so the two cannot disagree.",
          "The sync indicator in the header reads the real distance to the head of the sync log.",
          "The live transcript subscribes to the tail of a conversation, so a long thread streams new messages without loading its first page again.",
        ],
        docs: [{ href: "/documentation/sync-engine", label: "How the client syncs" }],
      },
      {
        title: "Limits pause a session; accounts and agents switch in place",
        accent: "orange",
        icon: "Hourglass",
        when: "Sep 1 to 18",
        items: [
          "Save more than one Claude account and run a session on any of them. When a usage limit lands, codecast recommends the saved account with the most headroom and switches when you approve, or on its own if you turn that on.",
          "A session parked on a limit gets its own card, and continues when the window resets.",
          "Switch a session's agent or model in place, without a new thread. One control panel holds model, switch agent, fork and hand off.",
          "`cast handoff --to` starts a linked session from a short brief of the current one.",
        ],
        docs: [{ href: "/documentation/usage-limits", label: "Usage limits" }],
      },
      {
        title: "Skills, agent definitions, and the line",
        accent: "blue",
        icon: "Sparkles",
        when: "Sep 13 to 14",
        items: [
          "23 `cast-*` skills ship inside the CLI and install as one catalog: pickup, handoff, verify, ship, review, triage, standup and more. Each is a fixed sequence of ordinary `cast` commands.",
          "An agent definition binds a client, a model, an effort, a tool policy and a system prompt under one name. Every launch surface resolves it by name, and definitions appear in the model picker.",
          "Workflow stations run as codecast sessions, and workflow templates ship inside the binary.",
          "A task that a role works needs an independent review to close, and `cast task handoff` carries the evidence to the reviewer.",
        ],
        docs: [
          { href: "/documentation/skills", label: "Skills" },
          { href: "/documentation/workflows", label: "Workflows" },
        ],
      },
      {
        title: "cast check, and a steadier daemon",
        accent: "green",
        icon: "Gauge",
        when: "Sep 4 to 18",
        items: [
          "`cast check` answers every session's typecheck from one shared `tsc --watch` for each tree. Later asks take seconds, and ten sessions asking cost the same as one.",
          "The daemon moved its probe, scan and ingest work to workers, and a watchdog restarts it if its loop hangs.",
          "A message sent into a busy terminal waits for proof that the paste landed once, so a long message no longer splits or sends twice.",
          "`cast status` checks DNS, the backend and latency, with `--json` for scripts.",
        ],
        docs: [{ href: "/documentation/typecheck", label: "cast check" }],
      },
      {
        title: "Triggers you can edit and gate",
        accent: "blue",
        icon: "Clock",
        when: "Sep 1 to 7",
        items: [
          "`cast trigger update` edits a trigger in place. Each edit is a version, and `cast trigger history` shows who changed what.",
          "`--precheck <command>` runs a shell gate before each firing. A gate that fails records a skipped run and spends no session.",
          "Every trigger has a detail page, visible to everyone who can see its session. A spawned run can pin its model.",
          "A stashed session returns to the inbox when a trigger wakes it, and `cast stash --hide` keeps it quiet.",
        ],
        docs: [{ href: "/documentation/triggers", label: "Triggers" }],
      },
      {
        title: "Chat reaches Slack, roles and sessions",
        accent: "magenta",
        icon: "MessagesSquare",
        when: "Sep 13 to 18",
        items: [
          "Mention a role or a session in chat, and it wakes and answers in the thread.",
          "A Slack workspace mirrors into team chat, with each sender shown under their own name.",
          "Chat gained message search and an emoji picker, and the site has a public support chat.",
          "An agent can sit in a huddle as a participant, and a session can follow its own room's huddle live. Walkie became a click toggle: a face offers Talk, Ring and Message.",
        ],
        docs: [
          { href: "/documentation/team-chat", label: "Team chat" },
          { href: "/documentation/calls", label: "Huddles and walkie" },
        ],
      },
      {
        title: "Session characters and follow mode",
        accent: "violet",
        icon: "Users",
        when: "Sep 13 to 17",
        items: [
          "Every session wears a character: one of 24 painted animal faces and a short name. The same face marks the thread in the inbox, the tab strip, chat and the org chart.",
          "Follow mode keeps your view on what a teammate is looking at, and viewer presence shows who reads a conversation with you.",
          "Files an agent sends to you render in the conversation, on web and on mobile.",
        ],
      },
      {
        title: "Notifications and mobile",
        accent: "yellow",
        icon: "Bell",
        when: "Sep 1 to 19",
        items: [
          "Sessions that need input fold into one digest across the server, web, phone and desktop, in place of one alert for each session.",
          "The app reads notification permission from the OS and nudges once when the OS is silencing banners. A sounds panel has a switch for each category and a volume slider.",
          "An iOS Live Activity on the lock screen shows the work state of every live session.",
          "Mobile gets dark mode, chat as a top level tab, and deep links that map every web URL onto a screen.",
        ],
      },
      {
        title: "A calmer interface",
        accent: "cyan",
        icon: "AppWindow",
        when: "Sep 1 to 19",
        items: [
          "A minimal interface style strips the chrome down for reading.",
          "Side by side is a tab split: drag a session row onto the stage, or option click to open an object beside what you read.",
          "`ctrl+tab` walks the objects you visited most recently, and an entity reference renders as a card that reveals its object inline.",
          "On desktop, chat and work open as windows of their own.",
        ],
      },
    ],
  },
  {
    id: "2026-08",
    month: "August 2026",
    sortDate: "2026-08-01",
    version: "v1.1.95 – v1.1.113",
    desktop: "Desktop v1.1.98",
    headline: "Decisions, a browser for agents, and a team that talks",
    summary:
      "This month agents learned to ask. `cast decide` puts a question in a queue you clear in your own time, and a pinned state line says where each thread stands before you open it. Agents got a browser, a terminal you can watch from another machine, and images that render in the thread. Teams got chat, huddles with transcripts, and push to talk.",
    sections: [
      {
        title: "cast decide: a queue for decisions",
        accent: "yellow",
        icon: "Scale",
        when: "Aug 14 to 27",
        items: [
          "`cast decide` posts one question with its options, what each option costs, and the reasoning. It lands in a queue you clear in one sitting.",
          "The answer returns to the session as a message. A blocking ask ends the agent's turn; `--advisory --default` lets it continue on a default that is cheap to undo.",
          "Permission prompts from every session appear as cards in the same queue.",
          "A posted decision stays correct: `cast decide edit` rewrites it in place, `cancel` withdraws it, and `ls` shows each open ask.",
        ],
        docs: [{ href: "/documentation/decisions", label: "Decisions" }],
      },
      {
        title: "Pinned state, and an inbox that says who acts next",
        accent: "cyan",
        icon: "Pin",
        when: "Aug 4 to 17",
        items: [
          "`cast state` pins a short line above the composer and on the inbox card: what the session is doing, what it waits on, and what is yours to decide.",
          "Every surface shows how far the thread has run since the line was written, so a neglected state reads as neglected.",
          "A finished turn now settles as Done or Dormant as well as Needs Input. Done means delivered. Dormant means a trigger or a background task will wake it.",
          "A turn parked on background work shows as waiting, and the inbox has a view grouped by trigger.",
        ],
        docs: [{ href: "/documentation/thread-state", label: "Pinned thread state" }],
      },
      {
        title: "cast browser: a browser for agents",
        accent: "orange",
        icon: "Globe",
        when: "Aug 12 to 26",
        items: [
          "`cast browser` gives each session its own tab in one managed browser. The loop is a snapshot, then an action on an element ref.",
          "`do` runs several steps in one process, and screenshots land in the thread.",
          "Watch an agent's browser live and take control from the live view. A cloud host also has a view of its whole screen.",
        ],
        docs: [{ href: "/documentation/browser", label: "cast browser" }],
      },
      {
        title: "Terminals on any machine",
        accent: "green",
        icon: "Terminal",
        when: "Aug 2 to 13",
        items: [
          "Each conversation has its own terminal, in a panel that takes the full height.",
          "Watch a tmux pane that runs on another machine, and type into it. Frames and keystrokes ride one leased stream in both directions.",
          "`cast resume --tmux` attaches to the pane a session runs in.",
          "Each device reports the git health of its repos, and a git key for each device lets you grant one machine access to a repo.",
        ],
        docs: [{ href: "/documentation/remote-and-cloud-sessions", label: "Remote and cloud sessions" }],
      },
      {
        title: "Team chat",
        accent: "magenta",
        icon: "MessagesSquare",
        when: "Aug 12 to 30",
        items: [
          "Channels, direct messages and threads, with typing indicators and search. A threads inbox lists every conversation you are in.",
          "Task, plan and session ids render as live references, and any link sends to chat from every share surface.",
          "A reply on a session's thread is relayed into that session, so the agent reads it as a message.",
          "Chat and calls are features that each team turns on.",
        ],
        docs: [{ href: "/documentation/team-chat", label: "Team chat" }],
      },
      {
        title: "Huddles and walkie",
        accent: "violet",
        icon: "Phone",
        when: "Aug 14 to 28",
        items: [
          "A huddle is a call room with presence. Every huddle is transcribed with exact speaker attribution.",
          "A finished huddle leaves a digest where it was held: a title, a summary and action items. `cast calls` lets an agent read what was said.",
          "Walkie is push to talk, and a teammate's face is the key. A voice burst becomes a call only when somebody steps in, and rooms warm up ahead of a burst so the first word is not lost.",
          "Phones ring through VoIP pushes, and the people wall opens from anywhere with `cmd+shift+p`.",
        ],
        docs: [{ href: "/documentation/calls", label: "Huddles and walkie" }],
      },
      {
        title: "Images in the thread",
        accent: "blue",
        icon: "Image",
        when: "Aug 8 to 13",
        items: [
          "`cast image` uploads a screenshot and prints a link that renders inline in any reply.",
          "A session has an image gallery, inbox rows show a thumbnail, and images carry captions.",
          "Images that a shell command wrote render in the thread, and dead local image links in agent prose are rescued.",
          "Guests on a share link see images too.",
        ],
      },
      {
        title: "Tasks: subtasks, statuses and projects",
        accent: "green",
        icon: "ListChecks",
        when: "Aug 5 to 25",
        items: [
          "Subtasks nest under the task they serve. Closing a parent with open subtasks is refused until you finish them or pass `--cascade`.",
          "Each team defines its own task statuses, and kanban columns drag into order.",
          "`cast project` creates and lists projects, and the task list groups and filters by label.",
          "A project page charts its progress, and `cast task show` takes several ids and `--json`.",
        ],
        docs: [{ href: "/documentation/tasks-and-plans", label: "Tasks and plans" }],
      },
      {
        title: "The workbench",
        accent: "blue",
        icon: "LayoutDashboard",
        when: "Aug 2 to 27",
        items: [
          "Open a session beside a task, a doc or a plan. Layout modes became two gestures: peek and pin.",
          "Saved views, sidebar pins, and a context menu on every object. Saved layouts sit on `⌥1` to `⌥9`.",
          "The command palette covers every feature, `?` lists every shortcut, and `r` quotes your selection into the reply.",
          "On desktop, a tab detaches into its own window, and `Cmd+N` pops a window out at once.",
        ],
      },
      {
        title: "Files: your markdown, in the app",
        accent: "yellow",
        icon: "FolderOpen",
        when: "Aug 1 to 21",
        items: [
          "Vault is now Files. Register a directory of markdown and the daemon serves it to the Files page. The files stay on your machine unless you turn on a mirror for your other devices.",
          "Live preview editing, daily notes, bookmarks, heading folds, a find bar and a quick switcher.",
          "`cast vault` searches, reads and writes notes from the terminal, and a change shows in an open tab within a second.",
        ],
      },
      {
        title: "Pages and canvas",
        accent: "cyan",
        icon: "FileText",
        when: "Aug 2 to 27",
        items: [
          "Artifacts are now pages, managed from the CLI with `cast publish ls` and `rm`. Viewers see the list of comments on a page.",
          "A published page embeds in the conversation that links it.",
          "The canvas gained declarative widgets: tabs, sortable tables, tooltips and charts, with a collapse for tall canvases and a wide layout.",
          "Share pages render on the server, and the docs gained deep dive guides.",
        ],
        docs: [
          { href: "/documentation/publish", label: "Published pages" },
          { href: "/documentation/visual-canvas", label: "The visual canvas" },
        ],
      },
      {
        title: "More agents, more machines",
        accent: "violet",
        icon: "Boxes",
        when: "Aug 3 to 26",
        items: [
          "Grok Build joins Claude Code, Codex, Cursor, Gemini, OpenCode and pi as a client.",
          "Windows installs and starts on boot through WSL, and one command takes a new machine from nothing to synced.",
          "The stable context feed installs for Codex, Cursor and OpenCode, and the model picker sets a default model for each agent client.",
          "`cast usage` shows your account's usage windows and reset times, and a session parked on a limit continues when the window resets.",
          "A capabilities page compares skills, MCP servers and plugins across your machines and shows where they drift.",
        ],
        docs: [{ href: "/documentation/usage-limits", label: "Usage limits" }],
      },
      {
        title: "Sync you can see, and a lighter client",
        accent: "green",
        icon: "Activity",
        when: "Aug 2 to 28",
        items: [
          "The sync chip says what the sync is doing, by scope.",
          "The backend keeps an append only sync log for each scope, with positions and acks. The client applies new entries in place of receiving whole query results again.",
          "Heartbeat fields moved off the session rows, so a heartbeat every second no longer pushes or renders the whole inbox again.",
          "We removed the session replay recorders, and tasks, triggers, workflows and devices now paint from the local store.",
        ],
        docs: [{ href: "/documentation/sync-engine", label: "How the client syncs" }],
      },
      {
        title: "Notifications and security",
        accent: "red",
        icon: "ShieldCheck",
        when: "Aug 2 to 17",
        items: [
          "Push routing knows where you are: the phone stays quiet while you are at a machine, and a storm of alerts arrives as one.",
          "API tokens bind to their device, and signup verifies your email.",
          "We closed reads across tenants on public functions and removed a public endpoint that confirmed whether a token was valid.",
          "Kill is final: it forces the teardown, cancels queued messages, and every surface shows the session as killed.",
        ],
      },
    ],
  },
  {
    id: "2026-07",
    month: "July 2026",
    sortDate: "2026-07-01",
    version: "v1.1.72 – v1.1.94",
    desktop: "Desktop v1.1.88",
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
        title: "The stable feed: sessions that know their neighbors",
        accent: "yellow",
        icon: "Activity",
        items: [
          "`cast stable` injects a feed of recent sessions into every new session at start, so an agent begins already knowing what was just worked on.",
          "Two scopes: solo injects your own recent sessions, team injects recent team activity with names attached.",
          "Each feed entry carries the session's short id, so the agent can read any of them for detail with `cast read`.",
          "Injection is a session-start hook with a timeout. If the fetch fails, the session simply starts without the feed.",
        ],
        docs: [{ href: "/documentation/ambient-awareness", label: "Ambient awareness" }],
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

/**
 * Comparison registry — the /compare/<slug> pages.
 *
 * Pure data, same contract as the guides registry (guides.ts): importable
 * outside Vite (bun server, bun tests), consumed by the compare index page,
 * the ComparePage renderer, and the SEO manifest (lib/seoRoutes.ts), so a new
 * comparison propagates to sitemap/prerender/llms.txt with no other edits.
 *
 * Voice rules for entries: factual and fair. Name the competitor's real
 * strengths; recommend them for the cases where they genuinely fit better.
 * These pages are written to be quoted — by people and by AI answers — so
 * every claim must stay true without context. No pricing claims about
 * competitors (they change), no star counts, no adjectives doing the work
 * facts should do.
 */

export interface ComparisonRow {
  dimension: string;
  codecast: string;
  competitor: string;
}

export interface ProsCons {
  pros: string[];
  cons: string[];
}

export interface DeepDive {
  heading: string;
  /** Plain paragraphs; one idea each. */
  paragraphs: string[];
}

export interface Comparison {
  slug: string;
  /** Competitor product name as it renders in headings and the table column. */
  competitor: string;
  competitorUrl: string;
  title: string;
  dek: string;
  /** One factual sentence per product, rendered as the opening frame. */
  codecastIs: string;
  competitorIs: string;
  rows: ComparisonRow[];
  whenCompetitor: string[];
  whenCodecast: string[];
  /** How the two compose, when they genuinely do; omit when they don't. */
  together?: string;
  /** One-paragraph bottom line, rendered as a callout under the opening frame. */
  bottomLine?: string;
  /** Strengths and weaknesses of each product, rendered as two cards under the table. */
  strengths?: { codecast: ProsCons; competitor: ProsCons };
  /** Long-form sections for comparisons that need more than a table. */
  deepDives?: DeepDive[];
  /** ISO date the competitor's docs were last read; rendered so a reader knows how fresh the facts are. */
  verifiedOn?: string;
}

const SHARED_ROWS = {
  model: {
    dimension: "Core model",
    codecast:
      "Records and steers the agent sessions you already run in your own terminals; adds a team layer on top",
  },
  agents: {
    dimension: "Agents supported",
    codecast: "Claude Code, Codex CLI, Cursor, Gemini (OpenCode and pi in progress)",
  },
  team: {
    dimension: "Team visibility",
    codecast:
      "Every teammate's sessions in one feed and inbox, with per-directory privacy controls",
  },
  memory: {
    dimension: "Search & memory",
    codecast:
      "Full-text search across all past sessions; agents query team history themselves (cast search / cast ask)",
  },
  blame: {
    dimension: "Line-level attribution",
    codecast: "cast blame traces any line of code to the conversation that wrote it",
  },
  remote: {
    dimension: "Remote steering",
    codecast: "Web, desktop, and iOS apps; answer permission prompts from any device",
  },
  oss: {
    dimension: "Open source",
    codecast: "MIT, self-hostable backend",
  },
} as const;

export const COMPARISONS: Comparison[] = [
  {
    slug: "codecast-vs-delta",
    competitor: "Delta",
    competitorUrl: "https://delta.dev",
    title: "Codecast vs Delta",
    dek: "Delta, from the makers of the Zed editor, is a new app where a thread owns its own checkout and records every edit between commits. Codecast records and steers the agent sessions your team already runs, in the terminals and on the machines you already use.",
    codecastIs:
      "Codecast is a team record and control layer for coding agents: a daemon on each machine watches the history files Claude Code, Codex, Cursor and Gemini already write and syncs every session into one searchable, steerable place, with tasks, plans, docs, triggers and line attribution built on that record.",
    competitorIs:
      "Delta is a desktop app from Zed Industries, in public beta since September 2026, built around the thread: a conversation with Delta's own agent, paired with an isolated checkout of your repository. Its sync layer, DeltaDB, records each edit and message in order between git commits and replicates the conversation and the working tree to everyone in the thread in real time.",
    bottomLine:
      "The two products make opposite bets. Delta asks you to move the work into one new app so it can own the checkout, run the agent and replay every keystroke of the change to your teammates. Codecast asks you to change nothing about how you run agents and gives your team the record, the memory and the controls around what those agents did. Pick Delta when the live, edit by edit, multiplayer thread is the thing you want. Pick codecast when your team already runs several agents on several machines and needs to see, search, steer and attribute all of it.",
    verifiedOn: "2026-09-20",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor:
          "A new app with its own agent; each thread owns an isolated checkout and DeltaDB records every edit between commits",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Delta's built in agent on Anthropic, OpenAI, GitHub Copilot, Grok, OpenRouter and other providers; a plugin that syncs Claude Code terminal sessions into threads is on the roadmap as in progress",
      },
      {
        dimension: "Where the agent runs",
        codecast: "In your own terminal, on whichever machine you started it; codecast never runs the model itself",
        competitor:
          "On the sender's machine from the desktop app; a turn sent from the browser uses a Delta hosted model and has no shell or local tools",
      },
      {
        dimension: "Unit of work",
        codecast: "The session; tasks, plans, docs and projects link to the sessions that did the work",
        competitor: "The thread: one conversation, one Delta worktree per project, one checkout per participant",
      },
      {
        dimension: "What gets recorded",
        codecast:
          "The agent's own transcript: every message, tool call, permission prompt and file edit, plus the commits that followed",
        competitor:
          "Every edit and message in sequence in DeltaDB; the repository's git objects and file contents are uploaded so the thread can be replayed anywhere",
      },
      {
        dimension: "Isolation",
        codecast:
          "Your checkout by default; cast ws creates a git worktree with its own env files, ports and setup when you want isolation",
        competitor:
          "Isolated Workspace by default: a managed checkout per thread under .delta; you can point a thread at your existing folder, and then threads that share it are not isolated",
      },
      {
        dimension: "Review",
        codecast:
          "Quote and comment on any reply, leave notes on diff lines, and send them as one batched review; review a teammate's session from its transcript and diff; batch reviews on pull requests",
        competitor:
          "Inline comments anchored to code passages in the Changes tab; review subthreads with an agent written change guide and an Approve or Request Changes verdict; Land Changes runs a landing skill in a subthread",
      },
      {
        ...SHARED_ROWS.team,
        competitor:
          "Threads are private until shared: invited by email (ten per thread), organization wide, or any signed in user with the link",
      },
      {
        dimension: "Working in one thread together",
        codecast:
          "Anyone with access reads the live transcript and can message the session; replies carry the sender's name; a session can have several owners and sit in several inboxes",
        competitor:
          "Everyone sees each other's drafts as they type; all pending drafts go to the agent as one turn; the sender's account pays for the turn and it runs on the sender's machine",
      },
      {
        ...SHARED_ROWS.memory,
        competitor:
          "Find within a thread; archived threads stay searchable; no documented search across threads and no memory the agent consults",
      },
      {
        ...SHARED_ROWS.blame,
        competitor: "Not documented as a feature; Delta's references anchor to changes rather than line numbers",
      },
      {
        ...SHARED_ROWS.remote,
        competitor:
          "delta.dev/threads in any browser, phones included, for reading, commenting and reviews; creating threads and running terminals need the desktop app",
      },
      {
        dimension: "Automation",
        codecast:
          "Triggers on a delay, an interval or a webhook; workflows with human gates; plans that run tasks in waves; org roles with standing agent sessions",
        competitor:
          "Subagents with Scout, Worker and Reviewer profiles in TOML (four per thread and eight overall by default); a landing workflow per project",
      },
      {
        dimension: "Agent safety",
        codecast:
          "The agent's own permission prompts stay in force and you can answer them from web, desktop or phone; secrets are redacted before sync",
        competitor:
          "No permission prompts and no sandbox today: the agent calls tools without asking, and prepare scripts, direnv and AGENTS.md run before you review them; secrets are redacted locally before upload",
      },
      {
        dimension: "Where your data lives",
        codecast:
          "A backend you can host yourself; project paths are hashed, each conversation has its own privacy level, and an optional mode encrypts bodies so the server cannot read them",
        competitor:
          "Zed's servers on Cloudflare (R2, Durable Objects, KV, D1), encrypted at rest with Cloudflare managed keys; no self hosting; deleting a thread locally leaves the server copy until you delete the account",
      },
      {
        dimension: "Platforms",
        codecast: "Daemon on macOS, Linux and Windows; web, a macOS desktop app, an iOS app, and blame in VS Code, Cursor and vim",
        competitor: "macOS 13 or later on Apple Silicon, Linux and Windows; one app instance at a time; a browser viewer",
      },
      {
        dimension: "Sign in",
        codecast: "Email and password or GitHub",
        competitor: "GitHub through a Zed account; no organization sign on documented",
      },
      {
        dimension: "Status",
        codecast: "Generally available; free for individuals, per seat for teams",
        competitor: "Public beta; free during the beta, with paid plans announced as coming on the Zed editor's billing",
      },
      { ...SHARED_ROWS.oss, competitor: "Closed source, built by Zed Industries" },
    ],
    strengths: {
      codecast: {
        pros: [
          "Records every session with no change to how anyone works: four agents, any machine, nothing to switch on.",
          "The record outlives the session. Full text and semantic search, questions across the whole corpus, and cast blame from any line back to the conversation that wrote it.",
          "Agents read the record themselves, so memory carries across sessions, people and months.",
          "Steer from anywhere: answer permission prompts, send instructions, fork, restart and reassign sessions from web, desktop or phone.",
          "Work tracking grows out of the record: tasks, plans, docs, projects, a decisions queue, triggers, workflows and org roles all link back to sessions.",
          "MIT licensed with a backend you can host yourself; per conversation privacy and optional encryption the server cannot read.",
        ],
        cons: [
          "It depends on each agent's own transcript format, so what a client does not expose stays absent: Cursor sessions cannot be launched or messaged, and Cursor and Gemini have no live state classifier.",
          "The checkout is shared unless you ask for a worktree, so two sessions in one folder can collide.",
          "Teammates read the transcript and the diffs; they do not get a live synced copy of the working tree to edit in the browser.",
          "Comments attach to messages and file lines, not to a passage that follows the code as it moves.",
          "It is not an editor. You still write code yourself in your terminal or IDE.",
          "A large surface. The inbox, tasks, plans, docs, chat, roles and triggers take time to learn.",
        ],
      },
      competitor: {
        pros: [
          "DeltaDB records every edit between commits and replays the conversation and the working tree together to every participant in real time.",
          "Each thread starts in its own checkout, so parallel threads cannot trample each other or your working folder.",
          "Review happens where the work happened: comments anchored to passages, review subthreads with a change guide, an approve or request changes verdict, and a landing skill that ships the change.",
          "Multiplayer composing: drafts are visible as people type and go to the agent as one turn.",
          "One agent, many providers. Switch models mid thread, sign in with ChatGPT, Copilot or Grok subscriptions, or bring API keys.",
          "A browser viewer for reading, commenting and reviewing with nothing installed, phones included.",
        ],
        cons: [
          "Public beta. The Claude Code plugin, MCP support, a remote runtime, sandboxing, permission prompts and conversation branching are roadmap items, not shipped.",
          "The agent acts without asking. Prepare scripts, direnv and AGENTS.md run before you review them.",
          "Your repository's file contents and git objects are uploaded to Zed's servers; there is no self hosting, and deleting a thread locally leaves the server copy.",
          "Sessions you run in your own terminal are not recorded today. The work happens inside Delta's app and Delta's agent.",
          "Real work needs the desktop app: macOS requires Apple Silicon, only one app instance runs at a time, and browser turns have no shell.",
          "Subthreads go one level deep, keybindings cannot be rebound, and there is no documented search across threads or memory for the agent.",
        ],
      },
    },
    deepDives: [
      {
        heading: "Two bets on where the work lives",
        paragraphs: [
          "Delta's founding claim is that the thread is where software happens now, so the thread should be the workspace. You add a project, Delta imports its files into DeltaDB, and every thread you open gets its own checkout under .delta with the conversation and the edits recorded together. Zed says it has turned pull requests off on Delta's own repository and lands changes from threads instead.",
          "Codecast starts from the opposite observation: your team already runs agents in terminals, IDEs and tmux panes on many machines, and the problem is that all of that evaporates when the pane closes. So the daemon records what is already happening and the product grows around the record: an inbox of every session by who acts next, search and memory over the corpus, and a control channel back into any live session.",
          "The practical difference is what you give up. Delta asks for a new app, a new agent and an upload of your repository. Codecast asks for a daemon and leaves the agent, the terminal and the git workflow exactly as they were.",
        ],
      },
      {
        heading: "What each one records",
        paragraphs: [
          "Delta records operations. Each edit gets a stable identity and a place in sequence, so you can scrub a thread back to any point, revert the conversation to the cursor, comment on a passage while the agent is mid turn, and hand a teammate the exact state of the working tree without a commit. That is a stronger primitive than a diff, and it is the reason Delta had to be a new application rather than a feature of git or of Zed.",
          "Codecast records the agent's own transcript: every message, tool call, permission prompt, thinking block and file edit, with diffs materialized per edit and commits tied back to the session. It does not replay keystrokes, but it keeps things Delta does not: which commands the agent ran, what it read, which prompt it was answering, and what the person said back. cast blame then joins git blame to that record so any line resolves to the conversation and the message that wrote it.",
          "The upload differs too. Delta stores your repository's git objects and file contents on Zed's Cloudflare infrastructure so that browser participants can see the worktree. Codecast stores transcripts and diffs, hashes project paths, redacts secrets before sync, and can run on your own backend.",
        ],
      },
      {
        heading: "Isolation and git",
        paragraphs: [
          "Delta isolates by default. Every thread gets a managed checkout, every participant gets their own checkout of that worktree on their own machine, and a prepare script runs when a checkout is created. The agent can push to a second remote named local, which points at your own repository, so a teammate can pick up a branch without going through origin. The cost is that two threads on the same branch name are two separate checkouts, and uncommitted work in one does not appear in the other.",
          "Codecast works in your checkout by default and treats isolation as something you ask for. cast ws acquire creates a git worktree with copied env files, its own port allocations and the project's setup commands, and cast ws destroy tears it down; a warm pool can keep worktrees ready. Because sessions run real git on real branches, landing work is ordinary: commit, push, open a pull request, and codecast binds the session to that pull request so reviews and failing checks wake it.",
        ],
      },
      {
        heading: "Review",
        paragraphs: [
          "Delta's review is the strongest part of the product. The Changes tab shows diffs against the branch base, the last commit or the last turn. You select a passage and type to comment; comments queue until your next message and reach the agent as targeted feedback on that exact passage. A review subthread asks the agent for a change guide, a walkthrough of the change in the order that explains it, and ends with Approve or Request Changes posted back to the parent. A skill marked as a landing action turns the merge into a subthread that runs checks and publishes.",
          "Codecast reviews at three levels. In a conversation you quote any reply, leave notes on diff lines and send them as one batched review to the session. Across sessions, a reviewer reads a teammate's transcript and diff and reports back to that session or its owner. On GitHub, cast pr holds notes and submits them as one review with a verdict, and the session that owns the pull request is woken with the whole review as one message.",
        ],
      },
      {
        heading: "Working together",
        paragraphs: [
          "In a shared Delta thread everyone can message, steer, edit files and comment, and drafts are visible as people type. All pending drafts go to the agent as one turn. The turn runs on the sender's machine with the sender's tools and credentials and is billed to the sender, so what the agent can reach depends on who pressed send. Browser participants get replicated files and a hosted model, not a shell.",
          "Codecast's collaboration is built around the inbox rather than the thread. Each session has one or more owners and appears in their inboxes sorted by who acts next; passing a session moves it to a teammate; cast send messages any session and the reply carries your name. Around the sessions sit team chat, transcribed calls with action items, a decisions queue that lets an agent ask a question without stopping, and an org model where roles hold standing sessions and a line of stations carries a task from analysis to review.",
        ],
      },
      {
        heading: "Safety and where the data goes",
        paragraphs: [
          "Delta's own docs are direct about this: the agent acts autonomously and does not ask before calling tools, there is no sandbox, and Delta runs a repository's prepare script, direnv file and AGENTS.md without asking you to review them first. Permissions, sandboxing and worktree trust are on the roadmap. Data is encrypted in transit and at rest on Cloudflare with Cloudflare managed keys, secrets are redacted on the device before upload, and account deletion is by email.",
          "Codecast leaves the agent's own permission model in place and lets you answer prompts from any device. It redacts secrets before sync, hashes project paths, supports a private, summary only or full visibility level per conversation, and can encrypt conversation bodies so the server never reads them. The backend is MIT licensed and documented for self hosting.",
        ],
      },
      {
        heading: "What is not there yet",
        paragraphs: [
          "Delta's roadmap, as of this reading, lists the Claude Code plugin, MCP support, a remote runtime, repository based access and web parity as in progress, and mentions, repository level context, sandboxing, WSL, conversation branching and a graph view as up next. Until the plugin ships, Delta only records work done through Delta's agent.",
          "Codecast has its own gaps, stated in its own docs. OpenCode and pi support is in the tree but pre release. A Codex fork inherits its parent's history but cannot yet take a follow up turn. Cursor sessions are ingested and resumable but cannot be launched or messaged from codecast. The team tier is early access with no self serve billing yet.",
        ],
      },
    ],
    whenCompetitor: [
      "You want the thread to be the workspace: an isolated checkout per conversation, every edit replayed live to teammates, and review anchored to passages of the change.",
      "You are happy to run one new app with its own agent, and to upload the repository so that anyone with a browser can follow along.",
      "You want to land changes from a thread instead of a pull request, and your team is small enough to invite by email.",
    ],
    whenCodecast: [
      "Your team already runs Claude Code, Codex, Cursor or Gemini on several machines and you want all of it recorded, searchable and steerable without changing how anyone works.",
      "You need the record afterward: search months later, agents that consult team history, and a line of code traced to the conversation that wrote it.",
      "You want the agent's permission prompts to stay in force and to answer them from your phone.",
      "You need the data to stay on infrastructure you control, or you need tasks, plans, triggers and roles built on the same record as the sessions.",
    ],
    together:
      "Today they do not overlap on disk: Delta's agent runs inside Delta and writes no transcript for a codecast daemon to watch. If you run Claude Code in a terminal against the same repository, codecast records that session as usual. Once Delta's Claude Code plugin ships, the same terminal session could sync into a Delta thread and into codecast at the same time.",
  },
  {
    slug: "codecast-vs-conductor",
    competitor: "Conductor",
    competitorUrl: "https://conductor.build",
    title: "Codecast vs Conductor",
    dek: "Conductor runs a fleet of agents in parallel from one Mac app. Codecast records and steers the sessions your whole team runs, on every machine.",
    codecastIs:
      "Codecast is a team dashboard and memory for coding agent sessions: a daemon syncs every session your team runs — any supported agent, any machine — into one searchable, steerable record.",
    competitorIs:
      "Conductor is a macOS app for running multiple Claude Code, Codex, and Cursor agents in parallel — each in an isolated workspace, locally or in Conductor's cloud sandboxes — with a dashboard for monitoring, review, and merging.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor:
          "Launches and manages agent runs itself, in worktrees it creates on your Mac",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code, Codex, and Cursor agents" },
      {
        dimension: "Where it runs",
        codecast: "Daemon on every machine where agents run; clients on web, desktop, iOS",
        competitor: "A macOS app; runs execute locally or in Conductor's cloud sandboxes",
      },
      { ...SHARED_ROWS.team, competitor: "Single-user: your Mac, your runs" },
      {
        ...SHARED_ROWS.memory,
        competitor: "Session history within the app for your local runs",
      },
      { ...SHARED_ROWS.blame, competitor: "Not a goal; review happens per-run before merge" },
      { ...SHARED_ROWS.remote, competitor: "On the Mac running it" },
      { ...SHARED_ROWS.oss, competitor: "Closed source" },
    ],
    whenCompetitor: [
      "You work solo on one Mac and mainly want to fan a feature out across parallel agents with clean worktree isolation.",
      "You want the tool itself to own launching, reviewing, and merging each run.",
    ],
    whenCodecast: [
      "More than one person (or one machine) runs agents, and you want everyone's sessions visible in one place.",
      "You want a permanent, searchable record — and agents that can consult it — rather than a per-run workflow.",
      "You steer long-running sessions from your phone or another machine.",
    ],
    together:
      "They compose: Conductor's runs are real Claude Code sessions, so a codecast daemon on the same Mac records them like any other session — Conductor for the parallel-run workflow, codecast for the team record.",
  },
  {
    slug: "codecast-vs-vibe-kanban",
    competitor: "Vibe Kanban",
    competitorUrl: "https://vibekanban.com",
    title: "Codecast vs Vibe Kanban",
    dek: "Vibe Kanban plans and dispatches agent tasks from a board. Codecast is the record and memory of every session your team's agents run.",
    codecastIs:
      "Codecast records every coding agent session your team runs into one searchable dashboard — with live steering, cross-session memory for agents, and line-level attribution — and layers tasks and plans on top of that record.",
    competitorIs:
      "Vibe Kanban is an open-source (Apache-2.0) kanban board for orchestrating coding agents: you write tasks as cards, dispatch them to agents like Claude Code, Codex, or Gemini, and review the results as they move across the board. Its maker, Bloop, announced in April 2026 that the project is sunsetting; the repository stays available and the community can continue it.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Task board first: cards dispatch agent runs it manages",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code, Codex, Gemini, Amp, and others" },
      {
        dimension: "Unit of work",
        codecast: "The session — tasks and plans link to the conversations that did the work",
        competitor: "The card — sessions exist inside tasks",
      },
      { ...SHARED_ROWS.team, competitor: "Board-level: shared view of tasks and their runs" },
      {
        ...SHARED_ROWS.memory,
        competitor: "History of tasks and their runs; not a cross-session search layer for agents",
      },
      { ...SHARED_ROWS.blame, competitor: "Per-task diffs and review" },
      { ...SHARED_ROWS.remote, competitor: "Web UI to the machine running it" },
      { ...SHARED_ROWS.oss, competitor: "Open source" },
    ],
    whenCompetitor: [
      "Your workflow is genuinely kanban: you think in cards, and agents are the executors you dispatch from the board.",
      "You want one tool to both define tasks and run the agents for them, and you're comfortable depending on a project its original maintainers have sunset.",
    ],
    whenCodecast: [
      "Your team already runs agents ad hoc in terminals and IDEs, and you want that reality captured rather than replaced.",
      "You want agents to remember: search past sessions, recall decisions, avoid redoing work.",
      "You need to answer \"which conversation wrote this line?\" months later.",
    ],
  },
  {
    slug: "codecast-vs-claude-code-remote-control",
    competitor: "Claude Code Remote Control",
    competitorUrl: "https://code.claude.com/docs/en/remote-control",
    title: "Codecast vs Claude Code Remote Control",
    dek: "Anthropic ships remote control for your own live Claude Code sessions. Codecast records every session your team runs, across four agents, and keeps them after they end.",
    codecastIs:
      "Codecast records every coding agent session your team runs — Claude Code, Codex, Cursor, Gemini, on any machine — into one searchable record you can steer, search months later, and trace back to the line of code it wrote.",
    competitorIs:
      "Remote Control connects claude.ai/code or the Claude mobile app to a Claude Code session running on your machine. You turn it on for a session with `claude --rc` or `/rc`, execution stays local, and you can read output, send instructions, and answer permission prompts from your phone or another browser.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Connects you to one of your own Claude Code sessions while it runs",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code" },
      {
        dimension: "What gets captured",
        codecast: "Every session automatically — the daemon watches the history files agents already write",
        competitor: "The sessions you switch it on for, per session or by enabling it for all of them",
      },
      {
        dimension: "After the session ends",
        codecast: "The conversation stays: searchable, linkable, and readable by your agents",
        competitor: "Remote Control is a live connection; it is not a history layer",
      },
      { ...SHARED_ROWS.team, competitor: "Your own sessions; a teammate's session is not yours to see or steer" },
      {
        ...SHARED_ROWS.memory,
        competitor: "None across sessions — each session keeps its own context",
      },
      { ...SHARED_ROWS.blame, competitor: "Not a goal" },
      {
        ...SHARED_ROWS.remote,
        competitor: "claude.ai/code plus the iOS and Android Claude apps, with push notifications for permission prompts",
      },
      {
        dimension: "Requirements",
        codecast: "Free for individuals; MIT, and the backend is self-hostable",
        competitor: "A Pro, Max, Team, or Enterprise plan (API keys are not supported); on Team and Enterprise an owner enables it first",
      },
      { ...SHARED_ROWS.oss, competitor: "Closed source, built by Anthropic" },
    ],
    whenCompetitor: [
      "You work alone in Claude Code and want to answer prompts from your phone. Remote Control is official, free with your plan, and goes deeper into the session than anything outside Anthropic can: your MCP servers, file path autocomplete, and live subagent and workflow progress.",
      "You want one live session mirrored across your terminal, browser, and phone at the same time.",
    ],
    whenCodecast: [
      "Your team runs agents, and you want to see and steer each other's sessions rather than only your own.",
      "You run more than Claude Code — Codex, Cursor, and Gemini sessions land in the same record.",
      "You want the sessions to still be there afterward: searchable months later, readable by your agents, and traceable from a line of code back to the conversation that wrote it.",
      "You do not want to remember to turn anything on — the daemon records every session, including the ones you did not plan to keep.",
    ],
    together:
      "They compose, and many people use both: Remote Control is a live connection to one Claude Code session, and codecast records that same session like any other. Use Anthropic's for the phone, codecast for the team record and the memory.",
  },
  {
    slug: "codecast-vs-happy",
    competitor: "Happy",
    competitorUrl: "https://github.com/slopus/happy",
    title: "Codecast vs Happy",
    dek: "Happy is a polished remote control for your own Claude Code sessions. Codecast is a team-wide record, memory, and steering layer for every agent.",
    codecastIs:
      "Codecast syncs every session your team runs — Claude Code, Codex, Cursor, Gemini — to one dashboard with live steering, full-text search, agent-usable memory, and line-level attribution.",
    competitorIs:
      "Happy is an open-source mobile and web client for Claude Code: it mirrors your sessions to your phone with end-to-end encryption, push notifications, and voice input, so you can watch and answer your own agents from anywhere.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Remote-controls the Claude Code sessions you run",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code (Codex support emerging)" },
      {
        dimension: "Designed for",
        codecast: "Teams (with a real single-player mode): shared feed, per-directory privacy",
        competitor: "An individual and their own sessions",
      },
      {
        ...SHARED_ROWS.memory,
        competitor: "Live mirroring and history of your sessions; no cross-session agent memory",
      },
      { ...SHARED_ROWS.blame, competitor: "Not a goal" },
      {
        ...SHARED_ROWS.remote,
        competitor: "Mobile-first apps with push notifications and voice; end-to-end encrypted",
      },
      { ...SHARED_ROWS.oss, competitor: "Open source" },
    ],
    whenCompetitor: [
      "You're solo, all-in on Claude Code, and want the smoothest possible phone remote with end-to-end encryption.",
      "Mirroring your own sessions is the whole job — you don't need search, memory, or a team layer.",
    ],
    whenCodecast: [
      "A team needs to see and steer each other's sessions, not just their own.",
      "You run more than one kind of agent.",
      "The history should work for you afterward: searchable by people, queryable by agents, attributable line by line.",
    ],
  },
  {
    slug: "codecast-vs-claudia",
    competitor: "Claudia",
    competitorUrl: "https://claudiacode.com",
    title: "Codecast vs Claudia",
    dek: "Claudia is a desktop GUI that wraps Claude Code on your machine. Codecast leaves your terminal alone and syncs every session to a team dashboard.",
    codecastIs:
      "Codecast doesn't replace how you run agents: a daemon watches the sessions you already run in your own terminal and syncs them — across agents and machines — to a shared, searchable, steerable record.",
    competitorIs:
      "Claudia is an open-source desktop app that wraps Claude Code in a GUI: manage projects and sessions, build custom agents, track usage and costs, and checkpoint session timelines, all locally on your machine.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "A GUI you run Claude Code inside, replacing the raw CLI",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code" },
      {
        dimension: "Your terminal workflow",
        codecast: "Unchanged — keep tmux, IDE terminals, SSH; codecast records alongside",
        competitor: "Moves into Claudia's interface",
      },
      { ...SHARED_ROWS.team, competitor: "Single-user, local data" },
      {
        ...SHARED_ROWS.memory,
        competitor: "Local session browser and checkpoints; usage and cost analytics",
      },
      { ...SHARED_ROWS.blame, competitor: "Not a goal" },
      { ...SHARED_ROWS.remote, competitor: "On the machine running it" },
      { ...SHARED_ROWS.oss, competitor: "Open source" },
    ],
    whenCompetitor: [
      "You want a local GUI for Claude Code itself — visual session management, custom agents, cost tracking — with everything on your machine.",
      "Sandboxed background agents on your desktop are the draw.",
    ],
    whenCodecast: [
      "You like your terminal exactly as it is and want recording, steering, and memory added around it.",
      "Sessions happen on more than one machine, by more than one person, or in more than one agent.",
    ],
    together:
      "They compose: Claudia launches real Claude Code sessions, which a codecast daemon on the same machine records like any other — GUI locally, team record everywhere.",
  },
];

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function compareHref(slug: string): string {
  return `/compare/${slug}`;
}

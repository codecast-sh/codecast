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
  /** Labelled items rendered as a list under the paragraphs, for sections that enumerate. */
  points?: { label: string; text: string }[];
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
    dek: "Delta, from the makers of the Zed editor, and codecast share a premise: the conversation with the agent is the unit of work, and the team should see it live. Delta builds that on its own agent and its own file history. Codecast builds it on the agents you already run and on git.",
    codecastIs:
      "Codecast is a team record and control layer for coding agents: a daemon on each machine watches the history files Claude Code, Codex, Cursor and Gemini already write and syncs every session live into one searchable, steerable place your team shares, with tasks, plans, docs, triggers and line attribution built on that record.",
    competitorIs:
      "Delta is a desktop app from Zed Industries, in public beta since September 2026, built around the thread: a conversation with Delta's own agent, paired with a checkout of your repository. Its sync layer, DeltaDB, records each edit and message in order between git commits and replicates the conversation and the working tree to everyone in the thread in real time.",
    bottomLine:
      "Both products start from the same idea, so the useful question is what each has that the other lacks. Delta has a short list codecast does not: a file history that records every edit from any source, a working tree that stays synced on every participant's machine and in the browser, comments that follow a passage as the code moves, and drafts that collaborators see as they type. Codecast has the rest: any agent on any machine, memory across every session, line attribution, remote and cloud runtimes, permission prompts, tasks and triggers, and a backend you can host. Much of Delta's roadmap already ships in codecast. Delta's file history does not, and it is the hard part to build.",
    verifiedOn: "2026-09-20",
    rows: [
      {
        dimension: "Core model",
        codecast:
          "The session is the unit of work, synced live to the team; codecast records the agents you already run and adds the team layer on top",
        competitor:
          "The thread is the unit of work, synced live to the team; Delta runs its own agent and records every file edit in DeltaDB",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Delta's built in agent on Anthropic, OpenAI, GitHub Copilot, Grok, OpenRouter and other providers; a plugin that syncs Claude Code terminal sessions into threads is on the roadmap as in progress",
      },
      {
        dimension: "File history",
        codecast:
          "Git, plus a diff for every edit the agent made through its tools, plus snapshots of the whole working tree on a hidden git ref",
        competitor:
          "DeltaDB records every edit to every file in order, whoever made it: the agent, a shell command or a person's editor",
      },
      {
        dimension: "Rewind",
        codecast: "Fork the conversation from any message; the fork's files start from the current checkout",
        competitor: "Revert the conversation and the files together to any earlier point",
      },
      {
        dimension: "The working tree for teammates",
        codecast:
          "Teammates see the transcript and the diffs live; the tree itself travels as a snapshot when a session moves to another machine or a cloud host",
        competitor:
          "Every participant gets a checkout that stays synced with the thread; browser participants open any file with no clone",
      },
      {
        dimension: "Isolation",
        codecast:
          "Your choice for each session: the shared checkout, or a git worktree from cast ws with its own env files, ports and setup",
        competitor:
          "Your choice for each thread: an isolated checkout under .delta by default, or your existing folder, where threads are not isolated",
      },
      {
        dimension: "Review",
        codecast:
          "Quote and comment on any reply, leave notes on diff lines, send them as one batched review; diff any range of messages; review a teammate's session; batch reviews on pull requests",
        competitor:
          "Comments anchored to passages that follow the code as it moves; review subthreads with an agent written change guide and an Approve or Request Changes verdict; a landing skill ships the change",
      },
      {
        dimension: "Working in one conversation together",
        codecast:
          "Anyone with access reads the live transcript and can message the session; replies carry the sender's name; a session can have several owners",
        competitor:
          "The same, plus drafts visible as people type, all pending drafts sent as one turn, and people editing files inside the thread",
      },
      {
        dimension: "Away from your machine",
        codecast:
          "Move a live session to another machine with its working tree, or fork branches onto a cloud host; steer from web, desktop and an iOS app",
        competitor:
          "A browser viewer for reading, commenting and reviews; a remote runtime is on the roadmap as in progress",
      },
      {
        dimension: "Conversation branching",
        codecast: "Fork from any message, several directions at once, locally or on a cloud host",
        competitor: "Subthreads one level deep; branching is on the roadmap as up next",
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
          "Zed's servers on Cloudflare (R2, Durable Objects, KV, D1), encrypted at rest with Cloudflare managed keys; the repository's file contents are uploaded; no self hosting",
      },
      {
        dimension: "Platforms",
        codecast: "Daemon on macOS, Linux and Windows; web everywhere, a macOS desktop app, an iOS app, and blame in VS Code, Cursor and vim",
        competitor: "Native desktop apps on macOS 13 or later with Apple Silicon, Linux and Windows; one app instance at a time; a browser viewer",
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
          "Records every session live with no change to how anyone works: four agents, any machine, nothing to switch on.",
          "The record outlives the session. Full text and semantic search, questions across the whole corpus, and cast blame from any line back to the conversation that wrote it.",
          "Agents read the record themselves, so memory carries across sessions, people and months.",
          "Already runs away from your desk: move a live session to another machine with its working tree, fork onto a cloud host, and answer permission prompts from a phone.",
          "Work tracking grows out of the record: tasks, plans, docs, projects, a decisions queue, triggers, workflows and org roles all link back to sessions.",
          "MIT licensed with a backend you can host yourself; per conversation privacy and optional encryption the server cannot read.",
        ],
        cons: [
          "The history of each edit is rebuilt from the agent's tool calls, so an edit made by a shell command, a formatter or a person's editor appears only at the next snapshot or commit.",
          "A fork branches the conversation but not the files: there is no rewind of the working tree to the state it had at an earlier message.",
          "Teammates do not get a continuously synced copy of the working tree, and the web app shows diffs, not the whole tree.",
          "Comments anchor to a file and line at a commit, so they do not follow a passage when the code moves.",
          "Drafts are private to the person typing; presence is coarse; nobody edits files inside the conversation.",
          "It depends on each agent's own transcript format: Cursor sessions cannot be launched or messaged, and the desktop app is macOS only.",
        ],
      },
      competitor: {
        pros: [
          "DeltaDB records every edit between commits from any source, so the file history is the ground truth and not a reconstruction.",
          "The conversation and the files rewind together to any earlier point.",
          "Every participant's checkout stays synced with the thread, and a browser participant opens any file with no clone.",
          "Comments follow the passage they were written on, even on uncommitted work while the agent is mid turn.",
          "Drafts are visible as people type and go to the agent as one turn; people can edit files inside the thread.",
          "Review opens with an agent written change guide and ends with a verdict; one agent works across many providers, with native apps on three platforms.",
        ],
        cons: [
          "Public beta. A remote runtime, the Claude Code plugin, MCP support, sandboxing, permission prompts, mentions and conversation branching are roadmap items, not shipped.",
          "The agent acts without asking. Prepare scripts, direnv and AGENTS.md run before you review them.",
          "Your repository's file contents and git objects are uploaded to Zed's servers; there is no self hosting, and deleting a thread locally leaves the server copy.",
          "Sessions you run in your own terminal are not recorded today. The work happens inside Delta's app and Delta's agent.",
          "No documented search across threads, no memory the agent consults, and no way to trace a line of code back to its conversation.",
          "No tasks, plans, scheduled runs or webhooks; no native phone app; one app instance at a time; keybindings cannot be rebound.",
        ],
      },
    },
    deepDives: [
      {
        heading: "The same premise, built two ways",
        paragraphs: [
          "Delta says the thread is where software happens now, so the thread should be the workspace. Codecast is built on the same belief. In both, the conversation with the agent is the unit of work, it syncs to teammates as it happens, anyone with access can read it live and steer it, and you choose whether it runs in an isolated checkout or in your own folder.",
          "The difference is what each product chose to own. Delta owns the agent and the file history: it ships its own harness and its own database of edits, and asks you to work inside its app. Codecast owns neither: it records the agents you already run in your own terminals, keeps files in git, and spends its effort on the layer above, which is the inbox, the memory, the control channel and the work tracking.",
          "Owning the file history gives Delta a few abilities that are hard to get any other way. Owning nothing gives codecast reach: every agent, every machine, every session, including the ones nobody planned to keep.",
        ],
      },
      {
        heading: "What Delta has that codecast does not",
        paragraphs: [
          "This list was checked against codecast's source, not its marketing. Each item is something Delta documents as shipped and codecast cannot do today.",
        ],
        points: [
          {
            label: "A file history that is the ground truth",
            text: "DeltaDB records every change to every file in the thread, in order, whoever made it. Codecast's history of each edit is rebuilt from the agent's tool calls, so a change made by a shell command, a formatter or a person's editor is missing until the next snapshot of the tree or the next commit.",
          },
          {
            label: "Rewind of the conversation and the files together",
            text: "Delta reverts a thread to any earlier point and the working tree goes with it. Codecast forks a conversation from any message, but the fork's files start from the current checkout, not from the state the files had at that message.",
          },
          {
            label: "A working tree that stays synced for everyone",
            text: "Each Delta participant gets a checkout that follows the thread, and a browser participant can open any file with no clone. Codecast syncs the transcript and the diffs live, and carries the real tree between machines as a snapshot on a hidden git ref, but that is a transfer at one moment and the web app shows diffs, not the tree.",
          },
          {
            label: "People editing files inside the thread",
            text: "Delta has file tabs with an edit mode, and a person's edits are recorded beside the agent's. Codecast is not an editor, and an edit a person makes in their own editor is not attributed in the record.",
          },
          {
            label: "Comments that follow the code",
            text: "Delta anchors a comment to the change, so it stays on its passage as code moves, and it works on uncommitted work while the agent is mid turn. Codecast anchors a comment to a file and line at a commit or in a worktree diff.",
          },
          {
            label: "Drafts your collaborators can see",
            text: "In a shared Delta thread each person's draft is visible as they type, and every pending draft goes to the agent as one turn. Codecast drafts are private to the window they are typed in, presence is coarse on purpose, and typing indicators exist only in team chat.",
          },
          {
            label: "A change guide",
            text: "A Delta review thread opens with a walkthrough the agent writes: the change in the order that explains it, with focused diffs. Codecast reviews from the transcript and the diff and has no generated walkthrough.",
          },
          {
            label: "Its own agent across providers",
            text: "One harness runs on Anthropic, OpenAI, Copilot, Grok and OpenRouter models, signs in with ChatGPT, Copilot or Grok subscriptions, and a browser turn needs no machine at all. Codecast can switch a session between Claude Code and Codex, but it has no harness of its own, so a provider with no supported agent CLI is out of reach.",
          },
          {
            label: "Native desktop apps on Windows and Linux",
            text: "Codecast's desktop app is macOS only. On Windows and Linux the daemon and the web app cover the same ground without the global shortcuts and native notifications.",
          },
        ],
      },
      {
        heading: "What codecast has that Delta does not",
        paragraphs: [
          "Several of these are on Delta's public roadmap, marked here where that is so.",
        ],
        points: [
          {
            label: "Any agent, any machine, nothing to switch on",
            text: "The daemon records Claude Code, Codex, Cursor and Gemini sessions wherever they run, including the ones nobody planned to keep. Delta records only work done through Delta's agent; its Claude Code plugin is on the roadmap as in progress.",
          },
          {
            label: "Memory across every session",
            text: "Full text and semantic search over the whole team's history, questions answered across the corpus, and agents that run those queries themselves before they start work. Delta documents search within a thread.",
          },
          {
            label: "Line attribution",
            text: "cast blame resolves any line of code to the conversation and the message that wrote it, in the terminal, VS Code, Cursor and vim.",
          },
          {
            label: "Remote and cloud runtimes",
            text: "Move a live session to another machine with its uncommitted work, or fork branches into worktrees on a cloud host. Delta lists a remote runtime as in progress.",
          },
          {
            label: "Conversation branching",
            text: "Fork from any message, in several directions at once, with the tree shown inline. Delta has subthreads one level deep and lists branching as up next.",
          },
          {
            label: "Permission prompts, answered from anywhere",
            text: "The agent's own permission model stays in force and a prompt can be approved from web, desktop or phone. Delta's agent does not ask before calling tools; permissions and sandboxing are on its roadmap.",
          },
          {
            label: "MCP servers and mentions",
            text: "The agents codecast records already use their own MCP servers, and people, sessions, tasks and docs can be mentioned in docs and team chat. Delta lists both as roadmap items.",
          },
          {
            label: "Work tracking and automation on the same record",
            text: "Tasks, plans, docs, projects, a decisions queue, triggers on a schedule or a webhook, workflows with human gates, pull requests bound to the session that owns them, and org roles with standing sessions.",
          },
          {
            label: "A phone app",
            text: "A native iOS app with push notifications, beside the web and desktop clients. Delta offers its browser viewer on phones.",
          },
          {
            label: "Open source and your own backend",
            text: "MIT licensed, documented for self hosting, with hashed project paths, a privacy level for each conversation and optional encryption the server cannot read. Delta is closed source and stores repository contents on Zed's Cloudflare infrastructure.",
          },
        ],
      },
      {
        heading: "Isolation and git",
        paragraphs: [
          "Both products let you choose. Delta defaults to an isolated checkout for each thread under .delta, runs a prepare script when it creates one, and lets you point a thread at your existing folder instead, where threads are no longer isolated from each other. Codecast defaults to your checkout and gives you a git worktree on request: cast ws acquire copies env files, allocates ports and runs the project's setup commands, and a warm pool can keep worktrees ready.",
          "Delta moves commits between machines itself, through a second remote named local that points at your own repository, so a teammate can pick up a branch without origin. Codecast uses git for the same job: a snapshot of the real working tree, uncommitted and untracked files included, goes to a hidden ref on your remote and is restored on the other machine. Codecast's route needs a shared remote; Delta's does not.",
        ],
      },
      {
        heading: "Review",
        paragraphs: [
          "Delta's review is the strongest part of the product. The Changes tab shows diffs against the branch base, the last commit or the last turn. You select a passage and type to comment; comments queue until your next message and reach the agent as feedback on that exact passage. A review subthread opens with the change guide and ends with Approve or Request Changes posted back to the parent. A skill marked as a landing action turns the merge into a subthread that runs checks and publishes.",
          "Codecast reviews at three levels. In a conversation you quote any reply, leave notes on diff lines, pick any range of messages to diff, and send the notes as one batched review to the session. Across sessions, a reviewer reads a teammate's transcript and diff and reports back to that session or its owner. On GitHub, cast pr holds notes and submits them as one review with a verdict, and the session that owns the pull request is woken with the whole review as one message.",
        ],
      },
      {
        heading: "Safety and where the data goes",
        paragraphs: [
          "Delta's own docs are direct about this: the agent acts autonomously and does not ask before calling tools, there is no sandbox, and Delta runs a repository's prepare script, direnv file and AGENTS.md without asking you to review them first. Permissions, sandboxing and worktree trust are on the roadmap. Data is encrypted in transit and at rest on Cloudflare with Cloudflare managed keys, secrets are redacted on the device before upload, and account deletion is by email.",
          "Codecast leaves the agent's own permission model in place and lets you answer prompts from any device. It redacts secrets before sync, hashes project paths, supports a private, summary only or full visibility level for each conversation, and can encrypt conversation bodies so the server never reads them. The backend is MIT licensed and documented for self hosting.",
        ],
      },
    ],
    whenCompetitor: [
      "You want every edit recorded from any source, and the conversation and the files to rewind together.",
      "Your team works in one thread at the same time: shared drafts, people editing files beside the agent, a synced checkout on every machine and in the browser.",
      "You want review comments that stay attached to a passage as the code moves, and a walkthrough of the change written for the reviewer.",
      "You are happy to run one new app with its own agent, and to upload the repository to Zed's servers.",
    ],
    whenCodecast: [
      "Your team already runs Claude Code, Codex, Cursor or Gemini on several machines and you want all of it recorded, searchable and steerable without changing how anyone works.",
      "You need the record afterward: search months later, agents that consult team history, and a line of code traced to the conversation that wrote it.",
      "You need sessions that run away from your desk today: on another machine, on a cloud host, steered from a phone, with permission prompts still in force.",
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

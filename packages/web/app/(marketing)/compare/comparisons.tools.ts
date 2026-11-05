// Comparisons with single-purpose Claude Code companions (session resume,
// multiplexers, remote and GUI clients), assembled into COMPARISONS by
// comparisons.ts. Same voice rules as that file's header.
import { SHARED_ROWS, type Comparison } from "./comparisonRows";

export const TOOL_COMPARISONS: Comparison[] = [
  {
    slug: "codecast-vs-resumecontext",
    competitor: "ResumeContext",
    competitorUrl: "https://resumecontext.com",
    title: "Codecast vs ResumeContext",
    dek: "Both sync the agent sessions your team already runs into one shared record. ResumeContext is that record for agents to read; Codecast is also where the team watches and steers the sessions while they run.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents. A daemon syncs every session your team runs into one searchable record, and the team watches, steers and answers those sessions live from web, desktop and phone, alongside the chat, tasks, docs and pull requests built on that record.",
    competitorIs:
      "ResumeContext is a shared memory layer for coding agents: a background daemon reads the session history agents write to disk and syncs it, about every twenty seconds, into one archive per project, which agents read back through a plain MCP server. Its site shows Claude Code, Cursor and Codex.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "A per project archive of past sessions that agents query through MCP",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code, Cursor and Codex are shown on its site" },
      {
        dimension: "How sessions are captured",
        codecast: "A daemon syncs the history files agents already write to disk",
        competitor: "The same approach: a daemon reads the history agents write, with no plugin or wrapper",
      },
      { ...SHARED_ROWS.team, competitor: "One archive per project shared by its members; revoking a member keeps their history attributed" },
      {
        ...SHARED_ROWS.memory,
        competitor: "Agents search the archive mid task through MCP tools, including read only SQL",
      },
      { ...SHARED_ROWS.blame, competitor: "Not documented" },
      { ...SHARED_ROWS.remote, competitor: "Not offered: the archive is history, and a running session appears after its next sync" },
      { ...SHARED_ROWS.oss, competitor: "Not stated on its site" },
    ],
    whenCompetitor: [
      "What you want is exactly a shared memory your agents query: past sessions in, answers out, through a plain MCP server.",
      "You do not need people to watch or steer sessions while they run.",
    ],
    whenCodecast: [
      "People need to see and steer the team's running sessions, including answering permission prompts from a phone.",
      "You want that record to carry the team's work around it: tasks, plans, docs, chat and pull requests linked to the sessions that did the work.",
      "You need to trace a line of code back to the conversation that wrote it.",
    ],
  },
  {
    slug: "codecast-vs-claude-squad",
    competitor: "Claude Squad",
    competitorUrl: "https://github.com/smtg-ai/claude-squad",
    title: "Codecast vs Claude Squad",
    dek: "Claude Squad runs several terminal agents side by side in one terminal window, each in its own git worktree. Codecast records every agent session you run, wherever you start it, and lets you read, search and steer them from web, desktop or phone.",
    verifiedOn: "2026-11-03",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon reads the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live from every machine you use. You read, search, message and steer those sessions from web, desktop or phone. It works for one person; a team layer is there when you share a project.",
    competitorIs:
      "Claude Squad is an open source (AGPL-3.0) terminal app, run as cs, that manages several agents in separate workspaces: it starts each one in its own tmux session and git worktree, lets you attach to reprompt it, shows a preview and a diff tab, and can commit and push a session's branch to GitHub. Claude Code is the default program; its README names Codex, Gemini and Aider, and any command can be set as the program.",
    bottomLine:
      "If you want to run several agents at once from one terminal, each on its own branch, with nothing to sign up for, Claude Squad does exactly that. If you want every session you run, in Claude Squad or anywhere else, kept as a record you can search later and steer from another device, that is Codecast. The two compose: Claude Squad starts real agent sessions, and Codecast records them.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Starts and manages agent instances itself, each in a tmux session on its own worktree",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Claude Code by default; Codex, Gemini and Aider are named in its README, and any terminal agent can be set as the program",
      },
      {
        dimension: "Where it runs",
        codecast: "A daemon on each machine where agents run; clients on web, macOS desktop and iOS",
        competitor: "A terminal UI on the machine running the agents; needs tmux and gh installed",
      },
      {
        dimension: "Parallel work",
        codecast:
          "Forks and workers started from a session (cast fork, cast spawn), each optionally in its own git worktree, on this machine or a cloud host",
        competitor: "The core job: one worktree and branch per task, reviewed in a diff tab, then committed and pushed from the UI",
      },
      { ...SHARED_ROWS.team, competitor: "Not stated; it manages the agents on one machine" },
      {
        ...SHARED_ROWS.memory,
        competitor: "Not stated; instances persist until you delete them, and cs reset clears them",
      },
      { ...SHARED_ROWS.blame, competitor: "Not stated" },
      { ...SHARED_ROWS.remote, competitor: "Not stated; you attach to sessions in the terminal running cs" },
      { dimension: "Pricing", codecast: "Free for one person, per seat for teams", competitor: "Not stated on its site" },
      { ...SHARED_ROWS.oss, competitor: "Open source, AGPL-3.0" },
    ],
    whenCompetitor: [
      "You live in the terminal and want to run several agents at once without managing worktrees and branches by hand.",
      "You want a small local tool with no account, no service and no other app, installed from Homebrew.",
    ],
    whenCodecast: [
      "You want every session kept after it ends, searchable months later and readable by your agents.",
      "You want to check on a long run or answer a permission prompt from your phone or another computer.",
      "You run agents on more than one machine, or start them from more than one tool, and want one record of all of it.",
    ],
    together:
      "They compose: Claude Squad's instances are ordinary Claude Code, Codex or Gemini sessions running in tmux, so a Codecast daemon on the same machine records them like any other session. Claude Squad runs the parallel tasks; Codecast keeps the record and the remote steering.",
  },
  {
    slug: "codecast-vs-paradev",
    competitor: "Paradev (formerly Superset)",
    competitorUrl: "https://paradev.com",
    title: "Codecast vs Paradev (formerly Superset)",
    dek: "Paradev, the desktop app formerly called Superset, runs CLI coding agents in parallel, one git worktree per task, with terminals, diffs, pull requests and a browser in the same window. Codecast records every agent session you run, wherever you start it, and lets you read, search and steer them from web, desktop or phone.",
    verifiedOn: "2026-11-03",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon reads the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live from every machine you use, whichever terminal, IDE or app started it. You read, search, message and steer those sessions from web, desktop or phone, and cast blame names the session behind each line of code. It works for one person; a team layer is there when you share a project.",
    competitorIs:
      "Paradev (formerly Superset) is a source available desktop app, under the Elastic License 2.0, for running CLI coding agents in parallel. Each task gets a workspace: its own git worktree, branch and persistent terminals. Around the agents it adds a Changes pane, pull requests with checks and review threads, an in-app browser, a file editor, automations that start agents on a schedule or an event, and Pages for sharing agent reports with a team. It runs on macOS, with an experimental Linux build, and has an iPhone and iPad app on its Pro plan.",
    bottomLine:
      "If you want one app to launch many agents at once, keep each on its own branch, and review, preview and merge their work in the same window, Paradev is built for that. If you want every session recorded no matter which tool or machine started it, kept and searchable afterward, traced from a line of code back to its conversation, and steerable from a browser or a phone, that is Codecast. They compose: sessions Paradev starts are real Claude Code or Codex sessions, and Codecast records them.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Launches agents itself, one workspace (git worktree and branch) per task, and wraps their launch commands to track status",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Claude Code, Codex, OpenCode, Gemini, Cursor Agent, Amp and others listed on its site, plus any CLI agent and a built in chat",
      },
      {
        dimension: "Where it runs",
        codecast: "A daemon on each machine where agents run; clients on web, macOS desktop and iOS",
        competitor: "A macOS desktop app (Linux AppImage experimental, Windows not yet available), plus remote hosts and cloud workspaces",
      },
      {
        dimension: "Parallel work",
        codecast:
          "Forks and workers started from a session (cast fork, cast spawn), each optionally in its own git worktree, on this machine or a cloud host",
        competitor: "The core job: a worktree per task, diffs and pull requests in the app, and recipes for racing agents or fanning out a refactor",
      },
      {
        ...SHARED_ROWS.team,
        competitor: "Organizations, Pages that teammates comment on, and a Tasks view over Linear and GitHub issues",
      },
      {
        ...SHARED_ROWS.memory,
        competitor: "Sessions resume after a crash and can be forked or handed to another agent; search across past sessions is not stated",
      },
      { ...SHARED_ROWS.blame, competitor: "Not stated" },
      {
        ...SHARED_ROWS.remote,
        competitor:
          "iPhone and iPad app on Paradev Pro (iOS 26 or later) reaching cloud workspaces or a connected computer; no web dashboard, Android on a waitlist",
      },
      {
        dimension: "Pricing",
        codecast: "Free for one person, per seat for teams",
        competitor: "A free tier; remote access, mobile and automations need Pro",
      },
      { ...SHARED_ROWS.oss, competitor: "Source available under the Elastic License 2.0, which its site notes is not OSI approved" },
    ],
    whenCompetitor: [
      "You want to run many agents at once on one repository and do the whole loop (prompt, review, preview, pull request, merge) inside one desktop app.",
      "You want automations that start an agent in a fresh workspace on a schedule or when a review is requested, a Sentry issue opens or a Slack message arrives.",
    ],
    whenCodecast: [
      "Your sessions start in many places (a terminal, an IDE, another app, another machine) and you want all of them in one record without changing how you start them.",
      "You want sessions kept after they end: searchable months later, readable by your agents, and traceable from a line of code back to the conversation that wrote it.",
      "You want to steer sessions from a browser or a phone without a paid plan, including answering their permission prompts.",
    ],
    together:
      "They compose: Paradev runs agents like Claude Code and Codex in ordinary terminals inside its worktrees, so a Codecast daemon on the same machine records those sessions like any other. Paradev runs the parallel work; Codecast keeps the record across every tool you use.",
  },
  {
    slug: "codecast-vs-omnara",
    competitor: "Omnara",
    competitorUrl: "https://www.omnara.com",
    title: "Codecast vs Omnara",
    dek: "Omnara is an open source platform for running AI agents you define, on any model and any machine, through an API. Codecast records and steers the coding agent sessions you already run, like Claude Code and Codex. They do different jobs.",
    verifiedOn: "2026-11-03",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon reads the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live from every machine you use. You read, search, message and steer those sessions from web, desktop or phone. It works for one person; a team layer is there when you share a project.",
    competitorIs:
      "Omnara is an open source (Apache-2.0) managed agent platform, which its site calls a self-hostable alternative to Claude Managed Agents and OpenAI's Agents API. You describe an agent in a config (instruction, model, machines, tools) and launch, steer and watch it through a REST API, a TypeScript SDK, a CLI or a dashboard. Agents run on any model provider, on sandboxes from providers such as Daytona, E2B or Modal, or on your own machine through its omnarad daemon, with approvals for risky tool calls, scoped secrets and an audit history. Its changelog says it relaunched in this form on September 2, 2026.",
    bottomLine:
      "If you are building agents for your users or your team and want an open source runtime with an API, sandboxes, permissions and an audit trail, Omnara is built for that, and Codecast is not. If you use coding agents like Claude Code and Codex yourself and want every session recorded, searchable and steerable from your phone, that is Codecast. Most people looking at both need only one of them.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Runs agents you define in a config, launched and observed through its API, SDK, CLI or dashboard",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Its own agents on any model through OpenAI, Anthropic, OpenRouter, LiteLLM, Bedrock or a compatible endpoint; running coding agent CLIs like Claude Code is not stated",
      },
      {
        dimension: "Where agents run",
        codecast: "Wherever you already run them; a daemon on each machine syncs the sessions",
        competitor: "Omnara Cloud or a self-hosted deployment, on pooled sandboxes or your own machine through the omnarad daemon",
      },
      {
        dimension: "Who it is for",
        codecast: "People who use coding agents, alone or as a team",
        competitor: "Developers deploying agents for their users or team, with Slack, Discord and GitHub integrations",
      },
      {
        ...SHARED_ROWS.team,
        competitor: "Role based access for people and API keys, and an append only audit history of agent actions",
      },
      {
        ...SHARED_ROWS.memory,
        competitor: "Each agent's state is a durable event log; memory stores are listed in its changelog",
      },
      { ...SHARED_ROWS.blame, competitor: "Not stated" },
      {
        ...SHARED_ROWS.remote,
        competitor: "Steer agents through the API, CLI or dashboard, with approval requests for risky tool calls; mobile apps are not stated",
      },
      {
        dimension: "Pricing",
        codecast: "Free for one person, per seat for teams",
        competitor: "No platform fee and free to self-host; optional pay as you go credits for models and machines",
      },
      { ...SHARED_ROWS.oss, competitor: "Open source, Apache-2.0, self-hostable with Docker Compose" },
    ],
    whenCompetitor: [
      "You are shipping agents inside your own product or to your team, and want an API, sandboxes, permissions and an audit trail you can self-host.",
      "You want to choose the model and the machine per agent, and change an agent's behavior mid-conversation without redeploying.",
    ],
    whenCodecast: [
      "You already use Claude Code, Codex, Cursor or Gemini and want every one of those sessions recorded and searchable.",
      "You want to read and steer your own coding sessions from a browser or a phone, including answering permission prompts.",
      "You want to trace a line of code back to the conversation that wrote it.",
    ],
  },
  {
    slug: "codecast-vs-happy",
    competitor: "Happy",
    competitorUrl: "https://github.com/slopus/happy",
    title: "Codecast vs Happy",
    dek: "Happy is a polished remote control for your own Claude Code sessions. Codecast is a workspace for a whole team and its agents: steering, memory, chat, tasks, docs and pull requests in one place.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents. It syncs every session your team runs (Claude Code, Codex, Cursor, Gemini, OpenCode and pi) with live steering, full-text search, agent-usable memory and line-level attribution, and adds the chat, tasks, docs, pull requests and decisions the team works in.",
    competitorIs:
      "Happy is an open-source (MIT) client for Claude Code and Codex, on iOS, Android, the web and macOS: it mirrors your sessions to your devices with end-to-end encryption, push notifications, and voice input, so you can watch and answer your own agents from anywhere.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Remote-controls the Claude Code sessions you run",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code and Codex" },
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
    competitor: "opcode (formerly Claudia)",
    competitorUrl: "https://opcode.sh",
    title: "Codecast vs opcode (formerly Claudia)",
    dek: "opcode, the app formerly called Claudia, is a desktop GUI that wraps Claude Code on your machine. Codecast leaves your terminal alone and brings every session into a workspace your team shares.",
    codecastIs:
      "Codecast doesn't replace how you run agents: a daemon watches the sessions you already run in your own terminal and syncs them, across agents and machines, into a workspace your team shares, with a searchable, steerable record and the chat, tasks, docs and pull requests built on it.",
    competitorIs:
      "opcode (formerly Claudia) is an open-source (AGPL) desktop app for Windows, macOS and Linux that wraps Claude Code in a GUI: manage projects and sessions, build custom agents, track usage and costs, manage MCP servers, and checkpoint session timelines, with all data kept on your machine.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "A GUI you run Claude Code inside, replacing the raw CLI",
      },
      { ...SHARED_ROWS.agents, competitor: "Claude Code" },
      {
        dimension: "Your terminal workflow",
        codecast: "Unchanged — keep tmux, IDE terminals, SSH; codecast records alongside",
        competitor: "Moves into opcode's interface",
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
      "They compose: opcode launches real Claude Code sessions, which a codecast daemon on the same machine records like any other — GUI locally, team record everywhere.",
  },
];

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
      "Records and steers every agent session you run, wherever you start it, from the history the agent already writes; a team layer is there when you want one",
  },
  agents: {
    dimension: "Agents supported",
    codecast:
      "Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok and Muse Spark, plus Cursor and Codex cloud agents",
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
    codecast:
      "Web, macOS desktop and iOS apps; send messages into a live terminal session and answer permission prompts from any device",
  },
  oss: {
    dimension: "Open source",
    codecast: "MIT, with a backend you can host yourself",
  },
} as const;

export const COMPARISONS: Comparison[] = [
  {
    slug: "codecast-vs-t3-code",
    competitor: "T3 Code",
    competitorUrl: "https://t3.codes",
    title: "Codecast vs T3 Code",
    dek: "T3 Code is an open source app you start agent threads inside. Codecast records every agent session you run, wherever you started it, and gives you one place to read, search, steer and automate all of them, alone or with a team. Threads you run in T3 Code sync into Codecast too.",
    verifiedOn: "2026-10-14",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon watches the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live, on every machine you use, including sessions you started in a terminal, an IDE or another app before you installed it. From web, desktop or phone you read them, search them, message them, answer their permission prompts, fork them and schedule follow ups. A team layer (shared feed, chat, tasks, docs, calls) is there when you want it and stays out of the way when you work alone.",
    competitorIs:
      "T3 Code describes itself as an agent harness control surface: desktop, web, iOS and Android apps for starting and steering agent threads on a machine you own, on your own Claude Code, Codex, Cursor, Grok Build, OpenCode and Antigravity logins plus ACP agents. It gives each thread a branch or worktree, opens the pull request, and has a built in terminal and simulator panel. It is MIT licensed, and its README says the project is very early.",
    bottomLine:
      "T3 Code is a window you move your agent work into: a thread exists in T3 Code because T3 Code started it. Codecast works the other way round. Keep starting agents however you like, in a terminal, in Cursor, in T3 Code, from a script, and Codecast records and steers all of them, with search, memory, line attribution, forks, triggers and cloud hosts on top. If you want one app to launch threads and press the pull request button, T3 Code is good at that. If you want every session you run, past and present, in one record you control from anywhere, that is Codecast, and it is free for one person.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor: "Starts and drives agent threads itself; a thread exists because T3 Code launched it",
      },
      {
        dimension: "Sessions you started elsewhere",
        codecast:
          "Every session on a supported agent syncs live, whether it started in a terminal, an IDE, T3 Code or a script, and history already on disk is picked up the first time the daemon runs",
        competitor:
          "A one time import in the first run wizard: Claude and Codex sessions from the last 30 days, capped at 200 messages each with tool activity dropped; nothing syncs afterwards, and continuing an imported Claude thread currently fails (open issue)",
      },
      {
        ...SHARED_ROWS.agents,
        competitor: "Claude Code, Codex, Cursor, Grok Build, OpenCode and Antigravity, plus pi, Muse and other ACP agents",
      },
      {
        dimension: "Machines",
        codecast:
          "Every machine with a daemon feeds one inbox and one history; move a live session between laptop and cloud host mid turn, uncommitted work included",
        competitor:
          "Clients connect to several paired machines, but each machine keeps its own SQLite history and threads stay where they started",
      },
      {
        ...SHARED_ROWS.memory,
        competitor:
          "Find threads by title and search your messages and the agent's final answers; no search over tool output and no memory agents consult",
      },
      { ...SHARED_ROWS.blame, competitor: "Not offered; each turn shows its own diff" },
      {
        ...SHARED_ROWS.remote,
        competitor:
          "iOS, Android, web and desktop through T3 Connect or direct pairing, with push notifications; the host machine must stay running and reachable",
      },
      {
        dimension: "Forks and other agents",
        codecast:
          "Fork from any message in several directions at once, spawn workers on any agent that report back, and switch a running session to another agent or model with its full history",
        competitor:
          "Fork from any response; send one prompt to several models in parallel worktrees; switching provider carries a budgeted summary of the thread (16k tokens by default)",
      },
      {
        dimension: "Git and pull requests",
        codecast:
          "Worktrees with their own env files and ports on request; every pull request and commit linked to the session that wrote it; the owning session wakes for reviews and failing checks",
        competitor:
          "A worktree per thread, one flow to commit, push and open the pull request on GitHub, GitLab, Bitbucket, Azure DevOps and others, stacked PRs, and rewind of the conversation with its files",
      },
      {
        dimension: "Automation",
        codecast:
          "Triggers on a delay, a schedule or an event, workflows with approval gates, plans run in waves, a decisions queue, and sessions that resume on another saved account at a usage limit",
        competitor: "Scheduled tasks and webhook triggers per project, /goal to keep working until a goal is met, resume at limit reset",
      },
      {
        dimension: "What agents can reach",
        codecast:
          "Your own signed in Chrome, native macOS apps, iOS simulators, published pages at a link, and messages to other sessions",
        competitor: "A built in terminal, an iOS Simulator or Android Emulator panel the agent can drive, and an MCP server other agents connect to",
      },
      {
        ...SHARED_ROWS.team,
        competitor: "None: access is per paired device, with no shared threads, share links or organizations",
      },
      {
        dimension: "Status",
        codecast: "Generally available; free for individuals, per seat for teams",
        competitor: "Version 0.0.x with several nightly builds a day; the README says to expect bugs; free",
      },
      { ...SHARED_ROWS.oss, competitor: "MIT; mostly not accepting outside contributions" },
    ],
    strengths: {
      codecast: {
        pros: [
          "Nothing to move: every session on eleven agent clients syncs live, wherever and however you started it, including your history from before you installed it.",
          "One record across all your machines and agents, searchable by keyword or meaning, askable in plain language, and readable by your agents before they start work.",
          "cast blame traces any line of code back to the conversation and the message that wrote it.",
          "Steer a live terminal session from web, desktop or phone: send messages, queue follow ups, approve or deny permission prompts.",
          "Work that runs without you: triggers, workflows, cloud hosts, live migration between machines, and automatic recovery at usage limits.",
          "Grows with you: share a project with a team and you get a shared feed, chat, calls, tasks, plans, docs and decisions on the same record.",
        ],
        cons: [
          "No one button flow to commit, push and open a pull request; that happens through the agent or cast pr.",
          "A fork branches the conversation but not the files, so there is no rewind of the working tree to an earlier message.",
          "No built in terminal or editor: you keep using your own.",
          "The desktop app is macOS only and the phone app is iOS only.",
          "Some agents lack capabilities: Gemini has no live state detection, and OpenCode, Grok and Muse launched from the web run without permission prompts.",
        ],
      },
      competitor: {
        pros: [
          "A polished single window to start, watch and review agent threads, with native apps on macOS, Windows, Linux, iOS and Android.",
          "Owns the git loop: a worktree per thread, a commit, push and pull request flow on many hosts, stacked PRs, and threads that settle when their PR merges.",
          "Rewind a thread with its files, and fan one prompt out to several models in parallel worktrees.",
          "A built in terminal and a simulator panel the agent can drive.",
          "Many harnesses, including ACP agents, on your own subscriptions.",
          "Free and MIT licensed.",
        ],
        cons: [
          "Sees only what it launched. Sessions from a terminal or IDE come in once, at setup, trimmed to 200 messages without tool activity; the import cannot be rerun later, and continuing an imported Claude thread fails today.",
          "History lives in a separate SQLite file on each machine, with no sync between them and no export of a whole thread.",
          "Search covers your messages and final answers only, and there is no memory agents can query and no line attribution.",
          "The host machine must stay on; there are no cloud hosts or moving a live thread to another machine.",
          "No teams, no sharing and no share links.",
          "Pre 1.0 with several nightly builds a day; the README warns to expect bugs.",
        ],
      },
    },
    deepDives: [
      {
        heading: "Where your sessions come from",
        paragraphs: [
          "This is the real difference. T3 Code is a place you start agents. Its history is the threads it launched, kept in a SQLite database on the machine that ran them. If you already have months of Claude Code and Codex sessions from your terminal, T3 Code offers to import them once, in its welcome wizard: sessions from the last 30 days, each cut to the first prompt and the newest messages up to 200, with tool calls and attachments dropped. After onboarding the import is unreachable, nothing you run outside T3 Code shows up again, and its issue tracker has open reports of imported Claude threads failing on the first follow up and of Codex subagents imported as dozens of junk threads.",
          "Codecast does not ask you to start agents anywhere in particular. Its daemon reads the transcripts Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok and Muse Spark already write, in full, tool calls included, and keeps reading them. A session you started in a tmux pane an hour ago, one Cursor ran in your IDE, one a cron job launched, and one you started in T3 Code all land in the same inbox, live, on every device. Nothing is trimmed, and nothing stops syncing after setup.",
        ],
      },
      {
        heading: "What codecast gives one person",
        paragraphs: [
          "Codecast is not only for teams. Everything below works on the free plan, for one person and their own machines.",
        ],
        points: [
          {
            label: "One inbox for every agent and machine",
            text: "Sessions sorted by who acts next: needs input, working, idle, done. Pin, stash, label and kill them. Laptop and cloud host sessions sit in the same list.",
          },
          {
            label: "Steer a terminal session from anywhere",
            text: "Messages you send from the web, the desktop app or the iOS app are typed into the live terminal session with delivery checks, and permission prompts can be approved from your phone.",
          },
          {
            label: "Search and ask across everything you have run",
            text: "Keyword and semantic search over every session, filtered by file, commit, pull request or time; cast ask answers a question across all of it, and your agents run the same queries before they start work.",
          },
          {
            label: "cast blame",
            text: "git blame whose author column is the conversation that wrote the line, in the terminal, the web repo view, VS Code, Cursor and vim.",
          },
          {
            label: "Forks, workers and switching agents",
            text: "Fork a conversation from any message in several directions at once, spawn workers on any agent that report back to the session that started them, or continue a session under another agent or model with its history.",
          },
          {
            label: "Cloud hosts and live migration",
            text: "Start a session on your own cloud machine from your checkout as it stands, mirror its tree back, and move live sessions between laptop and host mid turn.",
          },
          {
            label: "Triggers and workflows",
            text: "Follow ups after a delay, standing monitors on a schedule, and reactions to pull request comments or new issues, reporting into the session that armed them.",
          },
          {
            label: "Usage limits are a pause",
            text: "Save several Claude Code logins; a session that hits a limit parks and resumes at the reset or on the account with the most headroom.",
          },
          {
            label: "Agents that reach past the editor",
            text: "Drive your own signed in Chrome in a background tab, operate native macOS apps, use an iOS simulator from a shared pool, and publish reports and mockups at a link.",
          },
        ],
      },
      {
        heading: "What T3 Code does better",
        paragraphs: [
          "T3 Code owns the agent process, so it can do things around a thread that a recorder cannot.",
        ],
        points: [
          {
            label: "The pull request loop",
            text: "A worktree for each thread, one flow to commit, push and open the pull request on most git hosts, stacked PRs, and threads that settle themselves when the PR merges.",
          },
          {
            label: "Rewind with files",
            text: "Edit from an earlier message and revert the files too, on worktree threads. Codecast forks the conversation but the fork starts from the current checkout.",
          },
          {
            label: "A terminal and a simulator next to the thread",
            text: "A built in terminal and an iOS Simulator or Android Emulator panel the agent drives with its own tools.",
          },
          {
            label: "Platforms",
            text: "Native apps on Windows and Linux and an Android app. Codecast's desktop app is macOS only and its phone app is iOS only; elsewhere the daemon and the web app cover the same ground.",
          },
        ],
      },
    ],
    whenCompetitor: [
      "You want one app to start every thread in, and you are happy to start your agents there from now on.",
      "You want the app to own the worktree, the commit and the pull request button, and to rewind files with the conversation.",
      "You want a built in terminal and simulator panel, or native apps on Windows, Linux or Android.",
    ],
    whenCodecast: [
      "You already run agents in terminals, IDEs and scripts and want all of it, including the sessions you ran before today, recorded and steerable without changing how you work.",
      "You use more than one machine and want one history and one inbox across them, with live sessions you can move between laptop and cloud host.",
      "You want to search and ask across everything your agents have done, have agents read that history themselves, and trace a line of code to the conversation that wrote it.",
      "You want follow ups, monitors and workflows to run while you are away, and a team layer ready the day you share a project.",
    ],
    together:
      "They compose. T3 Code drives the agents' own harnesses, which keep their transcripts on disk, so a Codecast daemon on the same machine syncs a T3 Code thread like any other session. We checked this on 2026-10-12 with a Claude thread and a Codex thread started in the T3 Code desktop app: both appeared in Codecast with no setup, the Claude one within about a minute. Start threads in T3 Code if you like its window, and Codecast keeps them in the same record as everything else you run.",
  },
  {
    slug: "codecast-vs-amp",
    competitor: "Amp",
    competitorUrl: "https://ampcode.com",
    title: "Codecast vs Amp",
    dek: "Amp is a hosted coding agent: its own harness, threads stored on its servers, and cloud machines it starts for each thread. Codecast records and steers the agents you already run, Claude Code, Codex, Cursor and five more, on machines you control, and builds search, attribution, automation and a team layer on that record.",
    verifiedOn: "2026-10-14",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon watches the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live from every machine you use, including sessions started before you installed it. From web, desktop or phone you read, search, message and fork them and answer their permission prompts; triggers, workflows and cloud hosts keep work going while you are away; and a team layer (shared feed, chat, calls, tasks, docs, decisions) sits on the same record. It is MIT licensed with a backend you can host yourself.",
    competitorIs:
      "Amp, from Amp Frontier Corporation (spun out of Sourcegraph in December 2025), is a coding agent with its own harness. Threads run in orbs, cloud machines Amp creates for each thread, or on runners, machines of your own; you reach them from the web, macOS and iOS apps and a terminal CLI. Amp chooses the model behind each mode of its Dial, adds subagents such as Oracle and Librarian, and offers Puck, an assistant that starts and coordinates agents, in Slack and over MCP. Threads live on Amp's servers, shared with your workspace by default. It is closed source.",
    bottomLine:
      "The choice is about who owns the agent. Amp is the agent: you adopt its harness, its model choices and its servers, and in return you get managed cloud machines per thread, curated modes and a polished hosted product. Codecast owns no agent: you keep Claude Code, Codex, Cursor or whatever comes next, on your own subscriptions and machines, and Codecast gives all of them one record with search, line attribution, forks, permission prompts you answer from your phone, automation and a team layer. Pick Amp if you want one vendor to run the agent and the compute. Pick Codecast if you want to keep your agents and own the record of what they did.",
    rows: [
      {
        dimension: "Core model",
        codecast:
          "Records and steers the agents you already run, from the transcripts they write on your machines",
        competitor: "Is the agent: its own harness, with threads stored on Amp's servers",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Amp's own agent, with models Amp assigns to each mode; a Claude Code mode runs the Claude Agent SDK on your Claude plan inside an Amp thread",
      },
      {
        dimension: "Sessions you already have",
        codecast:
          "Every session on a supported agent syncs live, whether it started in a terminal, an IDE or another app, and history already on disk is picked up",
        competitor: "No import or view of sessions from Claude Code, Codex, Cursor or other agents; history starts with your first Amp thread",
      },
      {
        dimension: "Models",
        codecast:
          "Whatever your agents run, on your own subscriptions; pick model and effort at launch or change them mid session, and switch a session to another agent with its history",
        competitor:
          "Four modes (low, medium, high, ultra) with models chosen by Amp; Tune Modes pins a model and effort per mode, Oracle and subagents",
      },
      {
        dimension: "Where code runs",
        codecast:
          "Your machines and your own cloud hosts: start a session on a host from your checkout as it stands, and move live sessions between laptop and host mid turn",
        competitor:
          "Orbs, a managed cloud machine per thread that pauses when idle and is billed by the hour, or runners on your own machines, shareable with the workspace",
      },
      {
        dimension: "Where history lives",
        codecast: "A backend you can host yourself; transcripts stay on disk where your agents wrote them",
        competitor: "Amp's servers on Google Cloud, encrypted at rest; no self hosting",
      },
      {
        ...SHARED_ROWS.memory,
        competitor:
          "An activity feed and thread search by keyword, file, author, label or date; agents read other threads when you mention them",
      },
      { ...SHARED_ROWS.blame, competitor: "Not offered" },
      {
        dimension: "Branching and handoff",
        codecast:
          "Fork from any message in several directions at once; spawn workers on any agent that report back; cast handoff writes context for a fresh session",
        competitor: "Handoff starts a fresh thread with the context that matters; fork was removed in January 2026",
      },
      {
        dimension: "Permissions",
        codecast:
          "The agent's own permission prompts stay in force, answered from web, desktop or phone",
        competitor:
          "Does not ask before running tools by default; gating needs a policy plugin; orbs isolate each thread",
      },
      {
        ...SHARED_ROWS.remote,
        competitor:
          "Web, macOS and iOS apps; a running CLI thread can be opened and messaged from another device; orb threads keep running with the laptop closed",
      },
      {
        dimension: "Automation",
        codecast:
          "Triggers on a delay, a schedule or an event, workflows with approval gates, plans run in waves across agents, a decisions queue, and resume on another account at a usage limit",
        competitor:
          "A plain language schedule per thread, event driven orbs, threads that follow their PR's comments and checks, amp -x for CI, and SDKs for TypeScript and Python",
      },
      {
        dimension: "Coordinating agents",
        codecast:
          "Sessions message each other; cast spawn, fork and plan orchestrate run work in parallel; org roles keep standing sessions on an area",
        competitor: "Agents spawn and message each other; Puck starts, monitors and splits work across agents, by voice, in Slack or over MCP",
      },
      {
        dimension: "Pull requests and review",
        codecast:
          "The session that opened a PR owns it and wakes for reviews and failing checks; batched line reviews; every PR and commit linked to its sessions",
        competitor:
          "A GitHub App that pushes as you and subscribes threads to PR comments and checks (github.com only); amp review with checks you define; Restack",
      },
      {
        ...SHARED_ROWS.team,
        competitor:
          "One workspace per user, threads shared with it by default and admins able to read private ones; multiplayer threads; a call inside each thread; spend by model and member",
      },
      {
        dimension: "Around the sessions",
        codecast: "Team chat, calls, tasks, plans, docs, decisions and published pages, with agents taking part in each",
        competitor: "Slack through Puck, a voice and video Space in each thread",
      },
      {
        dimension: "Enterprise controls",
        codecast: "Per conversation privacy levels, hashed project paths, optional encryption the server cannot read, self hosting",
        competitor: "SSO, SCIM, groups, allowed model lists, an MCP allowlist, audit logs, IP allowlisting and SOC 2 Type II",
      },
      { ...SHARED_ROWS.oss, competitor: "Closed source" },
    ],
    strengths: {
      codecast: {
        pros: [
          "Keeps the agents you have: eleven agent clients, local and cloud, on your own subscriptions, and no new harness to learn.",
          "Every session you have run is in the record, including history from before you installed it, in full with tool calls.",
          "cast blame traces any line of code to the conversation and message that wrote it; agents search and ask across the whole history before they start.",
          "Fork any conversation from any message, in several directions, and switch a live session to another agent or model.",
          "Permission prompts stay on and can be answered from a phone.",
          "MIT licensed, self hostable, with per conversation privacy and optional encryption the server cannot read.",
          "Tasks, plans, docs, decisions, triggers, workflows, published pages, browser and macOS app control all on the same record.",
        ],
        cons: [
          "No managed cloud compute: cloud sessions run on a host you provide.",
          "No curated model modes or built in Oracle and Librarian style subagents; you get what your agents ship.",
          "No in house harness, so a capability your agent lacks (for example permission prompts on OpenCode launched from the web) is missing in Codecast too.",
          "Fewer enterprise controls today: no SCIM, audit log export or IP allowlisting.",
          "A fork branches the conversation, not the files.",
          "The desktop app is macOS only and the phone app is iOS only.",
        ],
      },
      competitor: {
        pros: [
          "Orbs: a cloud machine per thread that keeps working with the laptop closed and pauses when idle, with a shared terminal and desktop view.",
          "Curated modes with models picked and tuned by Amp, plus Oracle, Librarian and Search subagents.",
          "Thread references and handoff are first class: mention a thread and the agent reads it.",
          "Puck coordinates agents by voice, from Slack, or from Claude and ChatGPT over MCP.",
          "A full enterprise package: SSO, SCIM, audit logs, allowed models, SOC 2 Type II, and spend broken down by model and member.",
          "Free with your own runners and keys; model use billed at provider prices.",
        ],
        cons: [
          "Only Amp's agent. Sessions from Claude Code, Codex, Cursor and others are not imported or shown, and your history starts at your first Amp thread.",
          "Closed source and hosted only: threads live on Amp's servers with no self hosting.",
          "Does not ask before running tools by default.",
          "No line attribution, and fork, public threads, the editor extensions and custom commands have all been removed during 2026.",
          "One workspace per user, and admins can read members' private threads.",
          "GitHub integration covers github.com only, not GitHub Enterprise Server.",
        ],
      },
    },
    deepDives: [
      {
        heading: "Owning the agent versus owning the record",
        paragraphs: [
          "Amp's view is that the agent is the product. It ships its own harness, decides which model sits behind each mode, runs threads on machines it manages, and keeps every thread on its servers. That is how it can offer orbs, curated modes and a coordinator like Puck: it controls every piece.",
          "Codecast's view is that people should keep choosing their agents, and that the lasting value is the record of what those agents did. So it owns no agent. It reads the transcripts that Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok and Muse Spark write on your machines, syncs them live, and builds everything else on top: steering, search, attribution, forks, automation and the team layer. When a better agent ships next month, it joins the same record instead of starting a new silo.",
          "The tradeoff is real in both directions. Amp can do things only a harness owner can, such as pausing a whole machine with its thread. Codecast keeps working the day you change agents, and keeps the history you already have.",
        ],
      },
      {
        heading: "Your existing sessions",
        paragraphs: [
          "Amp has no way to bring in the work you did in other agents. Its closest feature, Claude Code mode, runs the Claude Agent SDK on your Claude plan inside a new Amp thread; it does not import the sessions already in your Claude Code history.",
          "Codecast starts from that history. The first time the daemon runs it picks up the sessions already on disk for every supported agent, and from then on each new session syncs live with its tool calls, diffs and permission prompts, whether you started it in a terminal, Cursor, T3 Code, a script or a trigger.",
        ],
      },
      {
        heading: "What Amp has that codecast does not",
        paragraphs: [],
        points: [
          {
            label: "Managed cloud machines",
            text: "Each orb is a cloud machine created for a thread, with a shared terminal and desktop view, that keeps working when you close the laptop and resumes intact after it pauses. Codecast runs cloud sessions on hosts you provide.",
          },
          {
            label: "Curated modes and specialist subagents",
            text: "Amp tunes the model and effort behind each of its four modes and adds Oracle for hard reasoning, Librarian for reading other codebases, and a Search subagent.",
          },
          {
            label: "Puck",
            text: "An assistant that starts, monitors and messages agents, splits work across them, takes voice, works in Slack, and is exposed over MCP to Claude and ChatGPT.",
          },
          {
            label: "Enterprise administration",
            text: "SCIM, groups, allowed model lists, an MCP registry allowlist, audit logs, IP allowlisting, SOC 2 Type II, and spend reporting by model, mode and member with CSV export.",
          },
          {
            label: "Code review checks",
            text: "amp review runs checks you define in your repository, and Restack tidies a branch's commits.",
          },
          {
            label: "A native app for iPad and macOS that runs threads",
            text: "The Mac app can act as a runner itself. Codecast's macOS app and iOS app steer sessions that run in your terminals and hosts.",
          },
        ],
      },
      {
        heading: "What codecast has that Amp does not",
        paragraphs: [],
        points: [
          {
            label: "Any agent, and the history you already have",
            text: "Eleven agent clients including Claude Code, Codex, Cursor and the Cursor and Codex cloud agents, with sessions from before you installed codecast included.",
          },
          {
            label: "Line attribution",
            text: "cast blame resolves any line of code to the conversation and message that wrote it, in the terminal, the web repo view, VS Code, Cursor and vim, and agent commits carry a trailer that leads back to the session.",
          },
          {
            label: "Forks",
            text: "Branch a conversation from any message, in several directions at once, locally or on a cloud host. Amp removed its fork in January 2026 in favor of handoff.",
          },
          {
            label: "Permission prompts from anywhere",
            text: "Your agent's own permission model stays in force and you approve or deny from web, desktop or phone. Amp runs tools without asking unless a policy plugin intervenes.",
          },
          {
            label: "Open source and your own backend",
            text: "MIT licensed and documented for self hosting, with per conversation privacy and optional encryption the server cannot read. Amp is closed source and hosted only.",
          },
          {
            label: "Work tracking on the same record",
            text: "Tasks assigned to agents, plans run in parallel waves, docs, a decisions queue, team chat, transcribed calls whose action items become tasks, and Linear and GitHub issue sync.",
          },
          {
            label: "Agents that reach past the code",
            text: "Drive your own signed in Chrome in a background tab, operate native macOS apps, use iOS simulators, and publish reports at a link with versions and comments.",
          },
          {
            label: "Usage limits are a pause",
            text: "Save several Claude Code logins; a session that hits a limit parks and resumes at the reset or on the account with the most headroom.",
          },
        ],
      },
      {
        heading: "Teams and privacy",
        paragraphs: [
          "Amp puts each user in one workspace. Threads in workspace projects are shared with the workspace by default, workspace admins can read members' private threads, and credits are pooled. Enterprise adds groups and visibility controls.",
          "Codecast keeps sessions private by default. You map a project directory to a team and its sessions are shared from then on, at the level each member chooses: hidden, a summary, or the full conversation. You can switch between a personal workspace and several teams, and the data can live on a backend you run.",
        ],
      },
    ],
    whenCompetitor: [
      "You want one vendor to provide the agent, the model choices and the cloud machines, and you are happy to move your work into its threads.",
      "You want a managed cloud machine for each thread that keeps going with your laptop closed.",
      "You need SCIM, audit logs, allowed model lists and IP allowlisting today.",
      "You like the idea of a coordinator you can talk to, from Slack or by voice.",
    ],
    whenCodecast: [
      "You use Claude Code, Codex, Cursor or several agents and want to keep them, on your own subscriptions.",
      "You want every session you have run, including history from before today, in one searchable record you can host yourself.",
      "You want to trace code to the conversation that wrote it, fork conversations, and keep permission prompts on while you steer from your phone.",
      "You want tasks, plans, docs, decisions, triggers and team chat built on the same record as the sessions.",
    ],
    together:
      "They do not overlap today. Amp threads run in Amp's harness and live on Amp's servers, so there is no transcript on disk for a codecast daemon to read. If your team runs Amp beside Claude Code or Codex, codecast records the Claude Code and Codex sessions as usual and Amp keeps its own threads.",
  },
  {
    slug: "codecast-vs-delta",
    competitor: "Delta",
    competitorUrl: "https://delta.dev",
    title: "Codecast vs Delta",
    dek: "Delta, from the makers of the Zed editor, and codecast share a premise: the conversation with the agent is the unit of work, and the team should see it live. Delta builds that on its own agent and its own file history. Codecast builds it on the agents you already run and on git.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents: chat, calls, tasks, plans, docs, pull requests, decisions and triggers, with agents taking part in each. A daemon on each machine watches the history files Claude Code, Codex, Cursor and Gemini already write and syncs every session live, so all of it is built on one searchable, steerable record with line attribution.",
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
          "Records every session live with no change to how anyone works: six agents, any machine, nothing to switch on.",
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
    dek: "Conductor runs a fleet of agents in parallel from one Mac app, and on its paid plans teammates can work in the same workspaces live. Codecast is the workspace a whole team and its agents share: every session on every machine, with the chat, tasks, docs and pull requests around them.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents. A daemon syncs every session your team runs, on any supported agent and any machine, into one searchable, steerable record, and the team's chat, tasks, plans, docs, pull requests and decisions live on that record with agents taking part in each.",
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
      { ...SHARED_ROWS.team, competitor: "Live collaboration in shared workspaces through Conductor Multiplayer on its Pro, Teams and Enterprise plans" },
      {
        ...SHARED_ROWS.memory,
        competitor: "Session history within the app for your local runs",
      },
      { ...SHARED_ROWS.blame, competitor: "Not a goal; review happens per-run before merge" },
      { ...SHARED_ROWS.remote, competitor: "The Mac app, plus web access and a mobile app on Pro and higher plans" },
      { ...SHARED_ROWS.oss, competitor: "Closed source" },
    ],
    whenCompetitor: [
      "You mainly want to fan a feature out across parallel agents with clean worktree isolation, and launch, review and merge those runs from one app.",
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
    dek: "Vibe Kanban plans and dispatches agent tasks from a board. Codecast is a full workspace for a team and its agents, where the task board is one surface beside chat, docs, pull requests and the record of every session.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents: an inbox of every session, chat, calls, tasks and plans, docs, pull requests, decisions and triggers. Agents are assignees and participants in each, and all of it sits on one searchable record with live steering, cross-session memory and line-level attribution.",
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
    dek: "Anthropic ships remote control for your own live Claude Code sessions. Codecast is a team workspace built on every session your team runs, across six agents, kept after they end.",
    codecastIs:
      "Codecast is a workspace for a team and its coding agents. It records every session your team runs (Claude Code, Codex, Cursor, Gemini, OpenCode and pi, on any machine) into one record you can steer, search months later and trace back to the line of code it wrote, and it puts the team's chat, tasks, docs, pull requests and decisions on that record.",
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
    slug: "codecast-vs-entire",
    competitor: "Entire",
    competitorUrl: "https://entire.io",
    title: "Codecast vs Entire",
    dek: "Both trace code back to the agent session that wrote it. Entire stores sessions as checkpoints inside your git repository, linked to the commits they produced. Codecast records every agent session you run, wherever you run it, and traces each line to the conversation and the message that wrote it.",
    verifiedOn: "2026-10-19",
    codecastIs:
      "Codecast is a workspace for your coding agents. A daemon reads the history files your agents already write, so every session on Claude Code, Codex, Cursor, Gemini, OpenCode, pi, Grok or Muse Spark syncs live from every machine you use, in any directory, committed or not. You read, search, message and steer those sessions from web, desktop or phone, and cast blame names the session behind each line of code. It works for one person; a team layer is there when you share a project.",
    competitorIs:
      "Entire is a developer platform built around git. Its open source, MIT licensed CLI is enabled per repository and uses git hooks and agent hooks to capture each agent session; when you commit, it saves the prompts, transcript and tool calls as a checkpoint stored in your own repository and adds an Entire-Checkpoint trailer to the commit. entire.io shows those sessions in the browser, and Entire also hosts and mirrors git repositories in regions close to your agents.",
    bottomLine:
      "If you want the record of agent work to live in git itself, readable by anyone with a clone and tied to each commit, Entire is built for that, and it adds git hosting, mirrors, search and multi agent review on top. If you want every session you run on every machine recorded whether or not it ever reaches a commit, line level attribution down to the message that made an edit, and the ability to steer live sessions from your phone, that is Codecast, and it is free for one person.",
    rows: [
      {
        ...SHARED_ROWS.model,
        competitor:
          "Captures sessions in each repository where you run entire enable and saves them as checkpoints linked to your commits",
      },
      {
        dimension: "What gets recorded",
        codecast:
          "Every session on a supported agent, in any directory, whether or not it ever commits; history already on disk is read the first time the daemon runs",
        competitor:
          "Sessions in Entire enabled repositories, saved as a checkpoint when you commit; entire import brings in earlier local sessions as read only checkpoints not linked to a commit",
      },
      {
        ...SHARED_ROWS.agents,
        competitor:
          "Built in: Claude Code (the default), Codex, Cursor, Copilot CLI, Factory Droid, OpenCode, Pi and Antigravity CLI; others through an agent integration protocol, with plugins for Goose, Kilo Code, Amp and Grok Build announced on its blog",
      },
      {
        dimension: "Where the record lives",
        codecast:
          "Codecast's backend (hosted, or one you host yourself); access follows the session's privacy and team sharing",
        competitor:
          "Your own git repository, under refs/entire/checkpoints/ by default or in a separate checkpoint repository; anyone with read access to the repository reads the checkpoints",
      },
      {
        ...SHARED_ROWS.blame,
        competitor:
          "entire blame tags each line AI, MX (mixed), HU or uncommitted, and entire why returns the commit, checkpoint, prompt and session behind a line; its FAQ says both answer at the level of the commit, not the line, and both are labs commands",
      },
      {
        dimension: "Link in the commit",
        codecast: "A Codecast-Session line in commits from sessions shared with your team",
        competitor: "An Entire-Checkpoint trailer with the checkpoint ID on every linked commit",
      },
      {
        ...SHARED_ROWS.memory,
        competitor:
          "Hybrid semantic and keyword search over checkpoints, commits and sessions, plus code search, from the CLI, entire.io or your agent",
      },
      {
        ...SHARED_ROWS.remote,
        competitor: "Not documented: entire.io shows captured sessions, and entire session resume continues past work, including in another agent",
      },
      {
        dimension: "Beyond sessions",
        codecast:
          "Triggers, workflows, forks and workers, cloud hosts, and a team layer of feed, chat, tasks, plans and docs",
        competitor:
          "Git hosting and regional GitHub mirrors, multi agent review and investigate commands, Dispatch summaries of recent work, and entire-graph code navigation for agents",
      },
      { dimension: "Pricing", codecast: "Free for one person, per seat for teams", competitor: "Not published on its site" },
      { ...SHARED_ROWS.oss, competitor: "The CLI is MIT licensed; the source of the entire.io service is not stated" },
    ],
    strengths: {
      codecast: {
        pros: [
          "Records every session without per repository setup, including sessions that never commit and those run outside any repository.",
          "cast blame resolves each line to the session whose edit wrote it, and opens the conversation at that message.",
          "Steer live terminal sessions from web, desktop or phone, including answering permission prompts.",
          "One record across all your machines and agents that you and your agents can search and ask questions of.",
        ],
        cons: [
          "The record lives in Codecast, not in your repository, so reading it needs Codecast access rather than a clone.",
          "The Codecast-Session commit line is added only for sessions shared with a team, and only for commits Claude Code makes directly.",
          "No git hosting, mirrors or built in multi agent review command.",
          "The desktop app is macOS only and the phone app is iOS only.",
        ],
      },
      competitor: {
        pros: [
          "The record travels with the code: checkpoints are git objects in your repository, so anyone with access can read them, with no separate service holding transcripts.",
          "A stable checkpoint ID in each commit message that survives rebases, amends and hosted merges.",
          "Redaction runs before checkpoint data is written, with user defined rules on top.",
          "The CLI runs on macOS, Linux and Windows and is MIT licensed.",
          "Git hosting and mirrors in regions near your agents, and review, investigate and dispatch commands for agent work.",
        ],
        cons: [
          "Captures only in repositories where it is enabled, and a session becomes a checkpoint when you commit.",
          "Attribution is commit level: a line hand edited inside an agent commit still reads as AI, by Entire's own FAQ.",
          "Steering a live session from another device is not documented.",
          "Checkpoints are readable by everyone who can read the repository; Entire advises a private repository for sensitive material.",
        ],
      },
    },
    deepDives: [
      {
        heading: "How each one answers \"which session wrote this line?\"",
        paragraphs: [
          "Entire starts from git. entire blame runs git blame, then looks at the commit that introduced each line: if that commit carries an Entire-Checkpoint trailer, the checkpoint holds the session, prompt and transcript behind it. entire why takes a file and line and returns that commit, checkpoint, prompt and session. Entire's FAQ is explicit that the answer describes the whole commit, so a line a person edited inside an agent commit still reads as AI, and a rebase or squash moves the line to whichever commit git now credits.",
          "Codecast also starts from git blame, then resolves each line two ways: the session that committed it, from the Codecast-Session line or its own record of the session's commits, and the session whose edit wrote that exact line, by matching the line against the edits sessions made. The authoring session wins when both are known, and the result links to the message where the edit happened. In the web repository view, setting Blame to Sessions shows the same thing in the gutter, with a strip that sums how much of the file each session wrote.",
        ],
      },
      {
        heading: "Where the record lives",
        paragraphs: [
          "This is the choice that decides it for most people. Entire writes redacted checkpoints into your repository, so the record of agent work is versioned with the code, pushed with it, and readable by anyone who can read the repository, with no Entire account. That is a real advantage when the history must stay with the code, and a real risk in a public repository, which Entire's security page points out.",
          "Codecast keeps sessions in its own backend, which you can host yourself. Nothing is written into your repository except the commit line for sessions shared with a team, and each session keeps its own privacy: private to you, or shared with a team. It also means Codecast holds sessions that never touched a repository at all: the research session, the one that only read code, the one in a scratch directory.",
        ],
      },
    ],
    whenCompetitor: [
      "You want the agent's reasoning stored in git next to the code, readable by anyone with access to the repository and with no separate service in the loop.",
      "Your team reviews work commit by commit and wants each commit to carry a checkpoint ID through rebases and hosted merges.",
      "You also want git hosting or regional mirrors for agents that clone and push a lot, or you work on Linux or Windows and want a native CLI there.",
    ],
    whenCodecast: [
      "You want every session recorded, in every directory and on every machine, including the ones that never commit.",
      "You need to know which session wrote a specific line, not only which commit it arrived in, and to open the conversation at that edit.",
      "You want to read and steer running sessions from your phone or another computer, answer their permission prompts, and search everything they have done.",
      "You work alone today and want a team layer ready for the day you share a project.",
    ],
  },
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

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function compareHref(slug: string): string {
  return `/compare/${slug}`;
}

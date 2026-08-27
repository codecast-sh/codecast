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

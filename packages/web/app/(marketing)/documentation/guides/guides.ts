/**
 * Guide registry — the deep technical articles under /documentation/<slug>.
 *
 * Each guide is a markdown file in ./content (imported raw by guideContent.ts)
 * rendered by the guide page (../[slug] route → GuidePage.tsx). This registry
 * is pure data — the single list the docs page, the guide page, the changelog
 * links, and the SEO manifest (lib/seoRoutes.ts) all read from, so a slug can
 * never drift from its content. Keep it importable outside Vite (bun server,
 * bun tests): no `?raw` imports, no browser APIs.
 *
 * Voice: technical documentation, not marketing. Explain how the thing works
 * mechanically — what gets written where, what happens at runtime, what the
 * failure behavior is. Ground every claim in the CLI's actual behavior.
 */


/** Categories in the order the docs Guides section shows them. */
export const GUIDE_CATEGORIES = [
  "The snippet system",
  "Recall",
  "Collaboration",
  "Work tracking",
  "Tools for agents",
  "Machines and accounts",
  "Output",
  "Under the hood",
] as const;

export type GuideCategory = (typeof GUIDE_CATEGORIES)[number];

export interface Guide {
  slug: string;
  title: string;
  /** One-line standfirst shown on cards and under the title. */
  dek: string;
  category: GuideCategory;
  /** The `cast install` slug when the guide documents an installable snippet. */
  installSlug?: string;
}

/** Ordered as they appear in the docs Guides section. */
export const GUIDES: Guide[] = [
  {
    slug: "agent-snippets",
    title: "How agent snippets work",
    dek: "cast install writes versioned instruction sections into your agents' own config files. This is the mechanism every other guide builds on.",
    category: "The snippet system",
  },
  {
    slug: "memory",
    title: "Give Claude Code memory across sessions and teammates",
    dek: "Not notes files: every session can search, read, and watch every other session your team has run. The commands, the scopes, and how agents use them.",
    category: "Recall",
    installSlug: "memory",
  },
  {
    slug: "search-sessions-across-machines",
    title: "How to search your Claude Code history across every machine",
    dek: "Claude Code keeps sessions on the machine that ran them. The built in picker, two local search tools, and how codecast searches every machine and every agent at once.",
    category: "Recall",
  },
  {
    slug: "which-session-wrote-this-line",
    title: "How to find which AI agent session wrote a line of code",
    dek: "git blame names whoever committed a line. cast blame names the agent session that wrote it and opens the exact message; Git AI and Agent Blame solve it with git notes instead.",
    category: "Recall",
  },
  {
    slug: "messaging",
    title: "Messaging between sessions",
    dek: "cast send turns sessions into teammates: any session can message any other, including a teammate's, and manage what the human sees in the inbox.",
    category: "Collaboration",
    installSlug: "messaging",
  },
  {
    slug: "ambient-awareness",
    title: "Ambient awareness",
    dek: "Stable mode injects a live feed of recent sessions into every new session at start. Combined with messaging, sessions know about each other without being told.",
    category: "Collaboration",
    installSlug: "stable",
  },
  {
    slug: "team-sessions",
    title: "See your whole team's Claude Code sessions in one place",
    dek: "Claude Code already writes every session to disk. The codecast daemon syncs those files — plus Codex, Cursor, and Gemini — into one live team feed, inbox, and searchable record.",
    category: "Collaboration",
  },
  {
    slug: "share-a-session",
    title: "How to share a Claude Code session with your team",
    dek: "Three different asks hide behind that sentence: read a finished conversation, watch a running one, or make every session visible by default. What Anthropic ships, what Lore does, and where codecast fits.",
    category: "Collaboration",
  },
  {
    slug: "thread-state",
    title: "Pinned thread state",
    dek: "cast state keeps one agent-written line saying where a thread stands, pinned above the composer and on the inbox card, with its staleness on show.",
    category: "Collaboration",
    installSlug: "state",
  },
  {
    slug: "decisions",
    title: "Decisions: asking without interrupting",
    dek: "cast decide puts a question, its options and the reasoning into a queue you clear when you choose to. The answer returns to the agent as a message.",
    category: "Collaboration",
    installSlug: "decide",
  },
  {
    slug: "team-chat",
    title: "Team chat that agents take part in",
    dek: "Channels, threads and direct messages where a mention can wake a role or a session, agent lines are capped, and a Slack workspace mirrors in.",
    category: "Collaboration",
    installSlug: "chat",
  },
  {
    slug: "calls",
    title: "Huddles and walkie",
    dek: "Every huddle is transcribed with exact speaker attribution and leaves a digest, so an agent can quote what was said on the call.",
    category: "Collaboration",
    installSlug: "calls",
  },
  {
    slug: "forks-and-spawn",
    title: "Forks and spawned sessions",
    dek: "cast spawn --subagent delegates a worker that nests under the session that launched it; plain cast spawn and cast fork start independent threads in the human's inbox.",
    category: "Collaboration",
    installSlug: "forks",
  },
  {
    slug: "tasks-and-plans",
    title: "Tasks and plans",
    dek: "The work tracking layer agents report into: tasks, plans, binding, comments, and the dashboard that watches it all.",
    category: "Work tracking",
    installSlug: "tasks",
  },
  {
    slug: "triggers",
    title: "Triggers",
    dek: "Follow-up work that runs after the session ends: delayed, recurring, or fired by a GitHub event.",
    category: "Work tracking",
    installSlug: "triggers",
  },
  {
    slug: "workflows",
    title: "Workflows",
    dek: "Execution graphs in DOT syntax: agent steps, shell commands, conditions, and human approval gates.",
    category: "Work tracking",
    installSlug: "workflows",
  },
  {
    slug: "orchestration",
    title: "Orchestration",
    dek: "A conductor agent decomposes a plan, spawns implementers in isolated worktrees, and runs reviewers and critics over the result.",
    category: "Work tracking",
    installSlug: "orchestration",
  },
  {
    slug: "pull-requests",
    title: "Pull requests and issues as codecast objects",
    dek: "cast pr and issue sync keep a copy of GitHub and Linear objects current from webhooks, send every action back, and wake the session that owns the work.",
    category: "Work tracking",
    installSlug: "pr",
  },
  {
    slug: "org-roles",
    title: "The org: roles, scopes and the line",
    dek: "Route work to a standing responsibility instead of a session: roles with scopes, wakes, proposals a person accepts, and a line that reviews before it ships.",
    category: "Work tracking",
  },
  {
    slug: "browser",
    title: "Driving the human's own Chrome",
    dek: "cast browser works in a background tab of the Chrome that already holds your logins, and puts the evidence in the thread.",
    category: "Tools for agents",
    installSlug: "browser",
  },
  {
    slug: "computer",
    title: "Driving a native macOS app",
    dek: "cast computer reads a window as an indexed tree, refuses stale indexes, and reports whether an action was verified.",
    category: "Tools for agents",
    installSlug: "computer",
  },
  {
    slug: "typecheck",
    title: "One typecheck watcher for every session",
    dek: "cast check answers every session from one tsc --watch for each tree and project, so thirty agents do not build the same program thirty times.",
    category: "Tools for agents",
    installSlug: "check",
  },
  {
    slug: "skills",
    title: "The cast-* skills",
    dek: "23 packaged procedures, compiled into the CLI, each a fixed sequence of ordinary cast commands.",
    category: "Tools for agents",
    installSlug: "skills",
  },
  {
    slug: "remote-and-cloud-sessions",
    title: "Sessions on machines you are not sitting at",
    dek: "How a session starts on, moves to, sleeps on and is watched from another machine, and what each lease does when the machine goes away.",
    category: "Machines and accounts",
  },
  {
    slug: "usage-limits",
    title: "Usage limits are a pause",
    dek: "Codecast parks a session that hits a limit, then continues it at the reset or on a saved account that still has room.",
    category: "Machines and accounts",
    installSlug: "limits",
  },
  {
    slug: "visual-canvas",
    title: "The visual canvas",
    dek: "Agents reply with sandboxed HTML that renders inline: charts, dashboards, diagrams, and small widgets instead of ASCII art.",
    category: "Output",
    installSlug: "visual",
  },
  {
    slug: "publish",
    title: "Published pages",
    dek: "cast publish turns a file into a page at a stable URL, with version history, access gates, and viewer comments that flow back to the session.",
    category: "Output",
    installSlug: "publish",
  },
  {
    slug: "sync-engine",
    title: "How the client syncs",
    dek: "Every surface paints from a local store, an append only log for each scope delivers only what changed, and one window syncs while the others copy it.",
    category: "Under the hood",
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function guideHref(slug: string): string {
  return `/documentation/${slug}`;
}

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
 * Voice: a product guide for the people who use codecast. Say what the
 * feature does for them, how to turn it on in the app, what to ask an agent,
 * what they will see, and what it will and won't do. The cast commands are
 * what agents run, not what people type, so a guide shows the app (real
 * screenshots, clipped to the surface they explain, captured with
 * scripts/app-element-shot.ts and nothing private in frame) rather than
 * commands. Ground every claim in the product's actual behavior.
 */


/** Categories in the order the docs Guides section shows them. */
export const GUIDE_CATEGORIES = [
  "Agent features",
  "Recall",
  "Working together",
  "Tracking and automation",
  "Hands on the machine",
  "Machines and accounts",
  "Showing the work",
  "Under the hood",
] as const;

export type GuideCategory = (typeof GUIDE_CATEGORIES)[number];

export interface Guide {
  slug: string;
  title: string;
  /** One-line standfirst shown on cards and under the title. */
  dek: string;
  category: GuideCategory;
  /** ISO date the guide first went live (its first commit), shown in its header. */
  published: string;
  /** The feature this guide documents, as Agent features names it, when it is one people switch on there. */
  feature?: string;
}

/** Ordered as they appear in the docs Guides section. */
export const GUIDES: Guide[] = [
  {
    slug: "agent-snippets",
    published: "2026-08-07",
    title: "How agent snippets work",
    dek: "cast install writes versioned instruction sections into your agents' own config files. This is the mechanism every other guide builds on.",
    category: "Agent features",
  },
  {
    slug: "memory",
    published: "2026-08-07",
    title: "Give Claude Code memory across sessions and teammates",
    dek: "Not notes files: every session can search, read, and watch every other session your team has run. The commands, the scopes, and how agents use them.",
    category: "Recall",
    feature: "memory",
  },
  {
    slug: "search-sessions-across-machines",
    published: "2026-09-25",
    title: "How to search your Claude Code history across every machine",
    dek: "Claude Code keeps sessions on the machine that ran them. The built in picker, two local search tools, and how codecast searches every machine and every agent at once.",
    category: "Recall",
  },
  {
    slug: "which-session-wrote-this-line",
    published: "2026-09-18",
    title: "How to find which AI agent session wrote a line of code",
    dek: "git blame names whoever committed a line. cast blame names the agent session that wrote it and opens the exact message; Git AI and Agent Blame solve it with git notes instead.",
    category: "Recall",
  },
  {
    slug: "messaging",
    published: "2026-08-07",
    title: "Messaging between sessions",
    dek: "cast send turns sessions into teammates: any session can message any other, including a teammate's, and manage what the human sees in the inbox.",
    category: "Working together",
    feature: "messaging",
  },
  {
    slug: "ambient-awareness",
    published: "2026-08-07",
    title: "Ambient awareness",
    dek: "Stable mode injects a live feed of recent sessions into every new session at start. Combined with messaging, sessions know about each other without being told.",
    category: "Working together",
    feature: "stable",
  },
  {
    slug: "team-sessions",
    published: "2026-08-20",
    title: "See your whole team's Claude Code sessions in one place",
    dek: "Claude Code already writes every session to disk. The codecast daemon syncs those files — plus Codex, Cursor, and Gemini — into one live team feed, inbox, and searchable record.",
    category: "Working together",
  },
  {
    slug: "share-a-session",
    published: "2026-09-13",
    title: "How to share a Claude Code session with your team",
    dek: "Three different asks hide behind that sentence: read a finished conversation, watch a running one, or make every session visible by default. What Anthropic ships, what Lore does, and where codecast fits.",
    category: "Working together",
  },
  {
    slug: "thread-state",
    published: "2026-08-12",
    title: "Pinned thread state",
    dek: "cast state keeps one agent-written line saying where a thread stands, pinned above the composer and on the inbox card, with its staleness on show.",
    category: "Working together",
    feature: "state",
  },
  {
    slug: "decisions",
    published: "2026-09-20",
    title: "Decisions: asking without interrupting",
    dek: "cast decide puts a question, its options and the reasoning into a queue you clear when you choose to. The answer returns to the agent as a message.",
    category: "Working together",
    feature: "decide",
  },
  {
    slug: "team-chat",
    published: "2026-09-20",
    title: "Team chat that agents take part in",
    dek: "Channels, threads and direct messages where a mention can wake a role or a session, agent lines are capped, and a Slack workspace mirrors in.",
    category: "Working together",
    feature: "chat",
  },
  {
    slug: "calls",
    published: "2026-09-20",
    title: "Huddles and walkie",
    dek: "Every huddle is transcribed with exact speaker attribution and leaves a digest, so an agent can quote what was said on the call.",
    category: "Working together",
    feature: "calls",
  },
  {
    slug: "forks-and-spawn",
    published: "2026-08-07",
    title: "Forks and spawned sessions",
    dek: "cast spawn --subagent delegates a worker that nests under the session that launched it; plain cast spawn and cast fork start independent threads in the human's inbox.",
    category: "Working together",
    feature: "forks",
  },
  {
    slug: "tasks-and-plans",
    published: "2026-08-07",
    title: "Tasks and plans",
    dek: "The work tracking layer agents report into: tasks, plans, binding, comments, and the dashboard that watches it all.",
    category: "Tracking and automation",
    feature: "tasks",
  },
  {
    slug: "triggers",
    published: "2026-08-07",
    title: "Triggers",
    dek: "Follow-up work that runs after the session ends: delayed, recurring, or fired by a GitHub event.",
    category: "Tracking and automation",
    feature: "triggers",
  },
  {
    slug: "workflows",
    published: "2026-08-07",
    title: "Workflows",
    dek: "Execution graphs in DOT syntax: agent steps, shell commands, conditions, and human approval gates.",
    category: "Tracking and automation",
    feature: "workflows",
  },
  {
    slug: "orchestration",
    published: "2026-08-07",
    title: "Orchestration",
    dek: "A conductor agent decomposes a plan, spawns implementers in isolated worktrees, and runs reviewers and critics over the result.",
    category: "Tracking and automation",
    feature: "orchestration",
  },
  {
    slug: "pull-requests",
    published: "2026-09-20",
    title: "Pull requests and issues as codecast objects",
    dek: "cast pr and issue sync keep a copy of GitHub and Linear objects current from webhooks, send every action back, and wake the session that owns the work.",
    category: "Tracking and automation",
    feature: "pr",
  },
  {
    slug: "org-roles",
    published: "2026-09-20",
    title: "The org: roles, scopes and the line",
    dek: "Route work to a standing responsibility instead of a session: roles with scopes, wakes, proposals a person accepts, and a line that reviews before it ships.",
    category: "Tracking and automation",
  },
  {
    slug: "browser",
    published: "2026-09-20",
    title: "Let agents use your Chrome",
    dek: "Agents check pages in the Chrome you already use, logins included, from their own background tabs. Screenshots and errors come back to the conversation.",
    category: "Hands on the machine",
    feature: "browser",
  },
  {
    slug: "computer",
    published: "2026-09-20",
    title: "Computer use: agents in your Mac apps",
    dek: "Agents work in Preview, Slack, System Settings or your own desktop build, in the background, with an orange pointer that shows where they act.",
    category: "Hands on the machine",
    feature: "computer",
  },
  {
    slug: "typecheck",
    published: "2026-09-20",
    title: "One typecheck watcher for every session",
    dek: "cast check answers every session from one tsc --watch for each tree and project, so thirty agents do not build the same program thirty times.",
    category: "Hands on the machine",
    feature: "check",
  },
  {
    slug: "skills",
    published: "2026-09-20",
    title: "The cast-* skills",
    dek: "23 packaged procedures, compiled into the CLI, each a fixed sequence of ordinary cast commands.",
    category: "Hands on the machine",
    feature: "skills",
  },
  {
    slug: "remote-and-cloud-sessions",
    published: "2026-09-20",
    title: "Sessions on machines you are not sitting at",
    dek: "How a session starts on, moves to, sleeps on and is watched from another machine, and what each lease does when the machine goes away.",
    category: "Machines and accounts",
  },
  {
    slug: "codex-cloud",
    published: "2026-10-02",
    title: "Codex Cloud tasks in codecast",
    dek: "Sync, start and drive Codex Cloud tasks on your ChatGPT plan: attempts as branches, pull requests, applying changes locally, and what happens when the private API changes.",
    category: "Machines and accounts",
  },
  {
    slug: "usage-limits",
    published: "2026-09-20",
    title: "Usage limits are a pause",
    dek: "Codecast parks a session that hits a limit, then continues it at the reset or on a saved account that still has room.",
    category: "Machines and accounts",
    feature: "limits",
  },
  {
    slug: "visual-canvas",
    published: "2026-08-07",
    title: "The visual canvas",
    dek: "Agents reply with sandboxed HTML that renders inline: charts, dashboards, diagrams, and small widgets instead of ASCII art.",
    category: "Showing the work",
    feature: "visual",
  },
  {
    slug: "publish",
    published: "2026-08-07",
    title: "Published pages",
    dek: "cast publish turns a file into a page at a stable URL, with version history, access gates, and viewer comments that flow back to the session.",
    category: "Showing the work",
    feature: "publish",
  },
  {
    slug: "sync-engine",
    published: "2026-09-20",
    title: "How the client syncs",
    dek: "Every surface paints from a local store, an append only log for each scope delivers only what changed, and one window syncs while the others copy it.",
    category: "Under the hood",
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** "August 7, 2026" for an ISO date, read as a calendar day (no timezone shift). */
export function formatGuideDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function guideHref(slug: string): string {
  return `/documentation/${slug}`;
}

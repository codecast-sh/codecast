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


export type GuideCategory =
  | "The snippet system"
  | "Recall"
  | "Collaboration"
  | "Work tracking"
  | "Output";

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
    slug: "thread-state",
    title: "Pinned thread state",
    dek: "cast state keeps one agent-written line saying where a thread stands, pinned above the composer and on the inbox card, with its staleness on show.",
    category: "Collaboration",
    installSlug: "state",
  },
  {
    slug: "forks-and-spawn",
    title: "Forks and spawned sessions",
    dek: "cast fork branches a conversation N ways; cast spawn starts fresh sessions. Both land in the inbox as work the human owns.",
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
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function guideHref(slug: string): string {
  return `/documentation/${slug}`;
}

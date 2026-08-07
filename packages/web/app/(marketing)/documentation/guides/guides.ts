/**
 * Guide registry — the deep technical articles under /documentation/<slug>.
 *
 * Each guide is a markdown file in ./content, imported raw at build time and
 * rendered by the guide page (../[slug] route → guidePage.tsx). This registry
 * is the single list the docs page, the guide page, and the changelog links
 * all read from, so a slug can never drift from its content.
 *
 * Voice: technical documentation, not marketing. Explain how the thing works
 * mechanically — what gets written where, what happens at runtime, what the
 * failure behavior is. Ground every claim in the CLI's actual behavior.
 */

import agentSnippets from "./content/agent-snippets.md?raw";
import memory from "./content/memory.md?raw";
import messaging from "./content/messaging.md?raw";
import ambientAwareness from "./content/ambient-awareness.md?raw";
import forksAndSpawn from "./content/forks-and-spawn.md?raw";
import tasksAndPlans from "./content/tasks-and-plans.md?raw";
import triggers from "./content/triggers.md?raw";
import workflows from "./content/workflows.md?raw";
import orchestration from "./content/orchestration.md?raw";
import visualCanvas from "./content/visual-canvas.md?raw";
import publish from "./content/publish.md?raw";

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
  content: string;
}

/** Ordered as they appear in the docs Guides section. */
export const GUIDES: Guide[] = [
  {
    slug: "agent-snippets",
    title: "How agent snippets work",
    dek: "cast install writes versioned instruction sections into your agents' own config files. This is the mechanism every other guide builds on.",
    category: "The snippet system",
    content: agentSnippets,
  },
  {
    slug: "memory",
    title: "Agent memory",
    dek: "Every session can search, read, and watch every other session. The commands, the scopes, and how agents use them.",
    category: "Recall",
    installSlug: "memory",
    content: memory,
  },
  {
    slug: "messaging",
    title: "Messaging between sessions",
    dek: "cast send turns sessions into teammates: any session can message any other, including a teammate's, and manage what the human sees in the inbox.",
    category: "Collaboration",
    installSlug: "messaging",
    content: messaging,
  },
  {
    slug: "ambient-awareness",
    title: "Ambient awareness",
    dek: "Stable mode injects a live feed of recent sessions into every new session at start. Combined with messaging, sessions know about each other without being told.",
    category: "Collaboration",
    installSlug: "stable",
    content: ambientAwareness,
  },
  {
    slug: "forks-and-spawn",
    title: "Forks and spawned sessions",
    dek: "cast fork branches a conversation N ways; cast spawn starts fresh sessions. Both land in the inbox as work the human owns.",
    category: "Collaboration",
    installSlug: "forks",
    content: forksAndSpawn,
  },
  {
    slug: "tasks-and-plans",
    title: "Tasks and plans",
    dek: "The work tracking layer agents report into: tasks, plans, binding, comments, and the dashboard that watches it all.",
    category: "Work tracking",
    installSlug: "tasks",
    content: tasksAndPlans,
  },
  {
    slug: "triggers",
    title: "Triggers",
    dek: "Follow-up work that runs after the session ends: delayed, recurring, or fired by a GitHub event.",
    category: "Work tracking",
    installSlug: "triggers",
    content: triggers,
  },
  {
    slug: "workflows",
    title: "Workflows",
    dek: "Execution graphs in DOT syntax: agent steps, shell commands, conditions, and human approval gates.",
    category: "Work tracking",
    installSlug: "workflows",
    content: workflows,
  },
  {
    slug: "orchestration",
    title: "Orchestration",
    dek: "A conductor agent decomposes a plan, spawns implementers in isolated worktrees, and runs reviewers and critics over the result.",
    category: "Work tracking",
    installSlug: "orchestration",
    content: orchestration,
  },
  {
    slug: "visual-canvas",
    title: "The visual canvas",
    dek: "Agents reply with sandboxed HTML that renders inline: charts, dashboards, diagrams, and small widgets instead of ASCII art.",
    category: "Output",
    installSlug: "visual",
    content: visualCanvas,
  },
  {
    slug: "publish",
    title: "Published pages",
    dek: "cast publish turns a file into a page at a stable URL, with version history, access gates, and viewer comments that flow back to the session.",
    category: "Output",
    installSlug: "publish",
    content: publish,
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function guideHref(slug: string): string {
  return `/documentation/${slug}`;
}

/**
 * The field manual: one blog series, a hub at /blog/field-manual and a chapter
 * at /blog/field-manual/<slug>. This registry is pure data (no `?raw` imports)
 * so lib/seoRoutes and the bun server can read it; the markdown bodies load in
 * chapterContent.ts. The hub's own entry lives in ../posts.ts with the rest of
 * the blog.
 */

import type { SOL } from "../blogChrome";

export const SERIES_SLUG = "field-manual";
export const SERIES_TITLE = "The codecast field manual";

export type ChapterPart = "operating-model" | "features";

export const PARTS: Record<ChapterPart, { label: string; title: string; dek: string }> = {
  "operating-model": {
    label: "Part one",
    title: "The operating model",
    dek: "How one person runs dozens of agents: who they report to, how their work reaches you, and how a conversation moves between them.",
  },
  features: {
    label: "Part two",
    title: "Ten things only codecast does",
    dek: "Each one exists because running agents at volume broke something.",
  },
};

export type Chapter = {
  slug: string;
  part: ChapterPart;
  /** Short name for the series nav and cards. */
  kicker: string;
  title: string;
  /** One-line standfirst shown on cards and under the chapter title. */
  dek: string;
  readingMinutes: number;
  /** Accent for the chapter's number and rules, a Solarized hue. */
  color: keyof typeof SOL;
  /** File name under public/blog/field-manual/ for the hub card. */
  cover: string;
};

export const CHAPTERS: Chapter[] = [
  {
    slug: "the-org",
    part: "operating-model",
    kicker: "The org",
    title: "The org: from one person with ten agents to a working org chart",
    dek: "Roles are standing agent sessions with an owner, a scope and a schedule. The work reports to them, they report to you, and a Head of People keeps the chart true.",
    readingMinutes: 14,
    color: "violet",
    cover: "org-chart.webp",
  },
  {
    slug: "the-inbox",
    part: "operating-model",
    kicker: "The inbox",
    title: "The inbox: one question per session, who acts next?",
    dek: "Every session sorted by whose move it is, the same on web, desktop and phone, and every action you can take on one: what it does, how to undo it, and its key.",
    readingMinutes: 12,
    color: "blue",
    cover: "inbox-hero.webp",
  },
  {
    slug: "switching-agents",
    part: "operating-model",
    kicker: "Switching agents",
    title: "Switching agents midstream without losing the thread",
    dek: "Move a live conversation from Claude Code to Codex, Grok, OpenCode or pi and keep every word: switch, fork, hand off or delegate, and when to pick which.",
    readingMinutes: 12,
    color: "cyan",
    cover: "switch-treehero.webp",
  },
  {
    slug: "team-memory",
    part: "features",
    kicker: "Team memory",
    title: "Team memory: every line of code sits on the conversation that wrote it",
    dek: "Every agent searches what every other agent learned, and the repo view names the session behind each line of code.",
    readingMinutes: 7,
    color: "violet",
    cover: "memory-blame.webp",
  },
  {
    slug: "decisions",
    part: "features",
    kicker: "Decisions",
    title: "Decisions: the calls only you can make, in one queue",
    dek: "Agents queue the questions only you can answer, with the reasoning attached, and keep working while you clear them in one sitting.",
    readingMinutes: 6,
    color: "yellow",
    cover: "decisions-answered.webp",
  },
  {
    slug: "triggers",
    part: "features",
    kicker: "Triggers",
    title: "Triggers: the work keeps going after you close the laptop",
    dek: "Timers, schedules and webhooks that run full agent sessions, with a precheck that spends nothing when nothing changed.",
    readingMinutes: 6,
    color: "orange",
    cover: "triggers-nightshift.webp",
  },
  {
    slug: "publish",
    part: "features",
    kicker: "Pages",
    title: "Pages: a URL for everything your agent makes",
    dek: "Reports, dashboards and mockups become pages with versions, diffs, gates and comments that flow back into the session that made them.",
    readingMinutes: 6,
    color: "cyan",
    cover: "publish-comments.webp",
  },
  {
    slug: "pull-requests",
    part: "features",
    kicker: "Pull requests",
    title: "Pull requests that know their session",
    dek: "Every PR carries the sessions that made it, and a review, a red check or a conflict wakes the agent that owns it.",
    readingMinutes: 5,
    color: "green",
    cover: "prs-merged.webp",
  },
  {
    slug: "browser",
    part: "features",
    kicker: "Your browser",
    title: "Your agents get a tab in the Chrome you are already signed in to",
    dek: "No fresh profile and no sign-in walls: each session drives a background tab in your own Chrome, and the evidence lands in the thread.",
    readingMinutes: 5,
    color: "red",
    cover: "browser-hero.webp",
  },
  {
    slug: "computer",
    part: "features",
    kicker: "Your Mac apps",
    title: "Your agent uses the apps on your Mac while you keep typing",
    dek: "Native apps through the accessibility tree, on windows behind yours, with every action read back and verified.",
    readingMinutes: 4,
    color: "magenta",
    cover: "computer-hero.webp",
  },
  {
    slug: "cloud-hosts",
    part: "features",
    kicker: "Cloud hosts",
    title: "Cloud hosts: start it on your laptop, let it run on your own cloud box",
    dek: "Send a session to your own EC2 host from the checkout you are in, uncommitted work included, mirror it back live, and move it home mid-turn.",
    readingMinutes: 6,
    color: "blue",
    cover: "cloud-hero.webp",
  },
  {
    slug: "calls",
    part: "features",
    kicker: "Calls",
    title: "Calls: decide it out loud, and the agents can quote you",
    dek: "Huddles transcribed with the speaker on every line, summarized with action items, and readable by any session.",
    readingMinutes: 6,
    color: "magenta",
    cover: "calls-hero.webp",
  },
  {
    slug: "mods",
    part: "features",
    kicker: "Mods",
    title: "Mods: agents extend the codecast app itself",
    dek: "Panes, palette commands, new kinds of objects and rich fenced blocks, built by an agent in the thread while you watch.",
    readingMinutes: 5,
    color: "green",
    cover: "mods-pane.webp",
  },
];

export function chapterHref(slug: string): string {
  return `/blog/${SERIES_SLUG}/${slug}`;
}

export function getChapter(slug: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function chapterImage(file: string): string {
  return `/blog/${SERIES_SLUG}/${file}`;
}

import { GUIDES, guideHref } from "../app/(marketing)/documentation/guides/guides";
import { POSTS } from "../app/(marketing)/blog/posts";
import { COMPARISONS, compareHref } from "../app/(marketing)/compare/comparisons";

/**
 * seoRoutes — the single source of truth for every publicly indexable route.
 *
 * Four consumers read this list, so a route added here propagates everywhere:
 *   1. scripts/prerender.mjs   — renders each route to static HTML at build time
 *      (dist/prerender/*) and generates dist/sitemap.xml.
 *   2. server/bot-meta.ts      — serves crawlers the prerendered snapshot, and
 *      falls back to these titles for social link unfurls.
 *   3. app/(marketing)/pageMeta.ts (useRouteMeta) — client-side document.title
 *      and meta description for human visitors.
 *   4. lib/__tests__/seoRoutes.test.ts — parity guard against
 *      src/routes.manifest.ts so a new marketing route cannot ship unindexed.
 *
 * Guide and blog entries derive from their registries (guides.ts, posts.ts),
 * so content additions are picked up with no edit here.
 */

export type SeoEntry = {
  /** Absolute path, no trailing slash ("/" for the root). */
  path: string;
  title: string;
  description: string;
  /** The page's own name for its social card, when the title carries a site suffix. */
  heading?: string;
};

export const SITE_URL = "https://codecast.sh";

export const DEFAULT_TITLE = "Codecast: the workspace for teams and their AI coding agents";
export const DEFAULT_DESCRIPTION =
  "Chat, calls, tasks, docs, pull requests and decisions, with Claude Code, Codex, Cursor and Gemini working as teammates in every one, and everything linked back to the session that did it.";

const STATIC_ENTRIES: SeoEntry[] = [
  {
    path: "/",
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
  },
  {
    path: "/about",
    title: "About — Codecast",
    description:
      "Why we built Codecast: it began as the record of every coding agent session and grew into the workspace where a team and its agents work together.",
  },
  {
    path: "/features",
    title: "Features — Codecast",
    description:
      "The cast CLI: every Codecast surface as a command. Agents use it to pick up tasks, answer chat threads, own pull requests, queue decisions, publish pages and search the team's history, on any machine.",
  },
  {
    path: "/documentation",
    title: "Documentation — Codecast",
    description:
      "Install the cast CLI, sync every agent session to one searchable place, and give your agents shared memory. Setup, commands, and deep guides.",
  },
  {
    path: "/pricing",
    title: "Pricing — Codecast",
    description:
      "Free forever for individuals. Team at $20/seat/month (early access). Enterprise on request. Bring your own agent subscriptions — codecast never resells or marks up model usage.",
  },
  {
    path: "/download",
    title: "Download — Codecast",
    description:
      "Download the Codecast desktop app for macOS. Watch, steer, and search every agent session.",
  },
  {
    path: "/blog",
    title: "Blog — Codecast",
    description:
      "Notes on agent memory, attribution, and steering coding agents at team scale.",
  },
  {
    path: "/changelog",
    title: "Changelog — Codecast",
    description:
      "What's new in Codecast: releases across the CLI, web, desktop, and mobile apps.",
  },
  {
    path: "/security",
    title: "Security — Codecast",
    description:
      "How Codecast protects your data: code stays on your machine, sessions sync over TLS, sharing is opt-in, and you can self-host the backend.",
  },
  {
    path: "/support",
    title: "Support — Codecast",
    description: "Get help with Codecast: setup, syncing, teams, and troubleshooting.",
  },
  {
    path: "/privacy",
    title: "Privacy Policy — Codecast",
    description: "The Codecast privacy policy: what we store, what we never look at, and your rights.",
  },
  {
    path: "/terms",
    title: "Terms of Service — Codecast",
    description: "The Codecast terms of service.",
  },
];

export const SEO_ROUTES: SeoEntry[] = [
  ...STATIC_ENTRIES,
  {
    path: "/compare",
    title: "Codecast vs the alternatives",
    description:
      "Honest side-by-side comparisons of Codecast with other coding agent tools — Delta, Conductor, Vibe Kanban, Happy, Claudia — and when each is the better choice.",
  },
  ...COMPARISONS.map((c) => ({
    path: compareHref(c.slug),
    title: `${c.title} — which coding agent tool fits?`,
    heading: c.title,
    description: c.dek,
  })),
  ...GUIDES.map((g) => ({
    path: guideHref(g.slug),
    title: `${g.title} — Codecast docs`,
    heading: g.title,
    description: g.dek,
  })),
  ...POSTS.map((p) => ({
    path: `/blog/${p.slug}`,
    title: `${p.title} — Codecast`,
    heading: p.title,
    description: p.dek,
  })),
];

const BY_PATH = new Map(SEO_ROUTES.map((e) => [e.path, e]));

export function seoFor(path: string): SeoEntry | undefined {
  return BY_PATH.get(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
}

/** Big headline on a route's social card: its own name, without the site suffix. */
export function cardHeading(entry: SeoEntry): string {
  return entry.heading ?? entry.title.replace(/ — Codecast$/, "");
}

/**
 * Site path of a route's 1200x630 social card. scripts/prerender.mjs renders
 * one per SEO route into dist/og/ and points og:image here.
 */
export function cardImagePath(path: string): string {
  return path === "/" ? "/og/index.png" : `/og${path}.png`;
}

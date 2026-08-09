import { GUIDES, guideHref } from "../app/(marketing)/documentation/guides/guides";
import { POSTS } from "../app/(marketing)/blog/posts";

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
};

export const SITE_URL = "https://codecast.sh";

export const DEFAULT_TITLE = "Codecast — watch, steer, and search every agent session";
export const DEFAULT_DESCRIPTION =
  "Codecast gives your team one place to watch, steer, search, and remember every AI agent session — Claude Code, Codex, Gemini, Cursor — on any machine.";

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
      "Why we built Codecast: coding agents forget everything between sessions, and teams lose the reasoning behind their own code. Codecast keeps the record.",
  },
  {
    path: "/features",
    title: "Features — Codecast",
    description:
      "The cast CLI and everything codecast records: a searchable memory of every agent conversation, cast blame from a line to the conversation that wrote it, a live inbox you can steer from anywhere, and the agents you already run.",
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
  ...GUIDES.map((g) => ({
    path: guideHref(g.slug),
    title: `${g.title} — Codecast docs`,
    description: g.dek,
  })),
  ...POSTS.map((p) => ({
    path: `/blog/${p.slug}`,
    title: `${p.title} — Codecast`,
    description: p.dek,
  })),
];

const BY_PATH = new Map(SEO_ROUTES.map((e) => [e.path, e]));

export function seoFor(path: string): SeoEntry | undefined {
  return BY_PATH.get(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
}

import type { Context, Next } from "hono";
import { readFile } from "fs/promises";
import { join } from "path";
import { api } from "../../convex/convex/_generated/api.js";
import type { Id } from "../../convex/convex/_generated/dataModel";
import { parseSharePath } from "@codecast/shared/entities";
import { convex, fetchShared, shareMeta } from "./shareData";
import { seoFor, SITE_URL } from "../lib/seoRoutes";

/**
 * Two distinct crawler populations, two distinct needs:
 *
 * SOCIAL unfurlers (Slack, Twitter, iMessage, …) only read <head> og tags to
 * draw a link card — a meta-only page with an empty body is exactly right,
 * and for private routes (/conversation, /share) it's also all we ever want
 * to reveal.
 *
 * SEARCH engines and AI crawlers index the BODY. Serving them the meta-only
 * page is how codecast.sh became invisible on Google (empty pages in the
 * index), so they must NEVER match the social list. For marketing routes
 * they get the build-time prerendered snapshot (dist/prerender/, written by
 * scripts/prerender.mjs — same React pages, so content parity with what a
 * human sees, i.e. not cloaking); everywhere else they fall through to the
 * SPA shell, which JS-executing crawlers can render.
 */
const SOCIAL_BOT_PATTERNS = [
  "Slackbot", "Twitterbot", "facebookexternalhit", "Facebot", "LinkedInBot",
  "Discordbot", "WhatsApp", "TelegramBot", "Pinterestbot", "redditbot",
  "Embedly", "Quora Link Preview", "Showyoubot", "outbrain", "rogerbot",
  "vkShare", "W3C_Validator",
];

const CRAWLER_PATTERNS = [
  // Search engines
  "Googlebot", "bingbot", "Applebot", "DuckDuckBot", "Baiduspider",
  "YandexBot", "Yeti", "SeznamBot",
  // AI / LLM crawlers — none of them execute JavaScript, so the prerendered
  // snapshots are the only codecast content they can ever ingest.
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-Web",
  "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot",
  "Perplexity-User", "CCBot", "Amazonbot", "meta-externalagent",
  "meta-externalfetcher", "Bytespider", "DuckAssistBot", "YouBot", "cohere-ai",
];

function matches(ua: string | undefined, patterns: string[]): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

const BASE_URL = SITE_URL;
const DIST_DIR = join(import.meta.dirname, "../dist");
const PRERENDER_DIR = join(DIST_DIR, "prerender");

// --- Prerendered snapshots ---------------------------------------------------
// manifest.json lists the exact route paths that have snapshots; anything else
// never touches the filesystem. Both the manifest and the documents are
// immutable for the lifetime of a deploy, so cache them in memory forever.
let snapshotPaths: Set<string> | null | undefined;
const snapshotCache = new Map<string, string>();

async function loadSnapshotPaths(): Promise<Set<string> | null> {
  if (snapshotPaths !== undefined) return snapshotPaths;
  try {
    const raw = await readFile(join(PRERENDER_DIR, "manifest.json"), "utf-8");
    snapshotPaths = new Set(JSON.parse(raw) as string[]);
  } catch {
    // No prerender output in this build — snapshots simply off.
    snapshotPaths = null;
  }
  return snapshotPaths;
}

async function getSnapshot(path: string): Promise<string | null> {
  const paths = await loadSnapshotPaths();
  if (!paths?.has(path)) return null;
  const cached = snapshotCache.get(path);
  if (cached) return cached;
  try {
    const file = path === "/"
      ? join(PRERENDER_DIR, "index.html")
      : join(PRERENDER_DIR, ...path.split("/").filter(Boolean), "index.html");
    const html = await readFile(file, "utf-8");
    snapshotCache.set(path, html);
    return html;
  } catch {
    return null;
  }
}

/**
 * How many marketing routes have a prerendered snapshot, for /api/health.
 * 0 means the prerender step failed and every crawler is getting the bare SPA
 * shell — the exact silent outage that ran for a week when the SSR build lost
 * its path aliases. Reuses the manifest the middleware already caches.
 */
export async function prerenderedRouteCount(): Promise<number> {
  return (await loadSnapshotPaths())?.size ?? 0;
}

// --- Meta-only unfurl pages --------------------------------------------------

function ogHtml(meta: { title: string; description: string; url: string; image?: string; type?: string }) {
  const img = meta.image || `${BASE_URL}/logo-final.png`;
  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8" />
  <title>${esc(meta.title)}</title>
  <meta name="description" content="${esc(meta.description)}" />
  <link rel="canonical" href="${esc(meta.url)}" />
  <meta property="og:title" content="${esc(meta.title)}" />
  <meta property="og:description" content="${esc(meta.description)}" />
  <meta property="og:url" content="${esc(meta.url)}" />
  <meta property="og:site_name" content="codecast" />
  <meta property="og:type" content="${meta.type ?? "website"}" />
  <meta property="og:image" content="${esc(img)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${esc(meta.title)}" />
  <meta name="twitter:description" content="${esc(meta.description)}" />
  <meta name="twitter:image" content="${esc(img)}" />
</head><body></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONVEX_ID_REGEX = /^[a-z0-9]{32}$/;

async function getConversationMeta(id: string, shareToken?: string) {
  if (!CONVEX_ID_REGEX.test(id)) return null;
  try {
    // A bare conversation id unfurls nothing for link-shared sessions — the
    // server requires the token to be PRESENTED (?share=, carried over from
    // the /share redirect). /share/<token> URLs unfurl via getShareMeta.
    const meta = await convex.query(api.conversations.getConversationMeta, {
      conversation_id: id as Id<"conversations">,
      ...(shareToken ? { share_token: shareToken } : {}),
    });
    if (!meta) return null;
    const title = meta.title || "Coding Session";
    const description = meta.description
      || (meta.author ? `${meta.message_count} messages by ${meta.author}` : `${meta.message_count} messages`);
    // Keep the presented token in og:url/canonical: unfurl cards link there,
    // and the tokenless URL would deny the very guest the link was minted for.
    const url = shareToken
      ? `${BASE_URL}/conversation/${id}?share=${encodeURIComponent(shareToken)}`
      : `${BASE_URL}/conversation/${id}`;
    return { title: `Codecast: ${title}`, description, url, type: "article" };
  } catch {
    return null;
  }
}

// /a/<slug> (published artifacts) is absent on purpose: that page is
// server-rendered by artifactPage.ts and carries its own og tags.
// Every /share/* kind (conversation, message, doc, plan) goes through
// parseSharePath + fetchShared, so a new share kind unfurls the moment it is
// registered in shareData — this table only holds non-share routes.
const ROUTES: Array<{ pattern: RegExp; handler: (match: RegExpMatchArray, search: URLSearchParams) => Promise<{ title: string; description: string; url: string; type?: string } | null> }> = [
  { pattern: /^\/conversation\/([a-z0-9]{32})$/, handler: (m, search) => getConversationMeta(m[1], search.get("share") ?? undefined) },
];

export async function botMetaMiddleware(c: Context, next: Next) {
  const ua = c.req.header("user-agent");
  const social = matches(ua, SOCIAL_BOT_PATTERNS);
  const crawler = matches(ua, CRAWLER_PATTERNS);
  if (!social && !crawler) return next();

  const reqUrl = new URL(c.req.url);
  const path = reqUrl.pathname;

  // Marketing routes: full prerendered documents for every kind of bot. The
  // snapshot carries real body content AND the og tags, so it satisfies both.
  const snapshot = await getSnapshot(path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
  if (snapshot) return c.html(snapshot);

  if (social) {
    const share = parseSharePath(path);
    if (share) {
      const result = await fetchShared(share.kind, share.token);
      const meta = result ? shareMeta(share.kind, share.token, result.value, BASE_URL) : null;
      if (meta) return c.html(ogHtml(meta));
    } else {
      for (const route of ROUTES) {
        const match = path.match(route.pattern);
        if (match) {
          const meta = await route.handler(match, reqUrl.searchParams);
          if (meta) return c.html(ogHtml(meta));
          break;
        }
      }
    }
    const entry = seoFor(path);
    if (entry) {
      return c.html(ogHtml({ ...entry, url: path === "/" ? BASE_URL : `${BASE_URL}${path}` }));
    }
  }

  // Search/AI crawlers on non-marketing routes (and any social fallthrough):
  // the SPA shell. JS-capable crawlers render it; the rest see the default
  // meta, which is still honest.
  return next();
}

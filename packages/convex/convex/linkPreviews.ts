import { v } from "convex/values";
import { query, internalAction } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import { parseLinkPreviewUrl } from "@codecast/shared/entities";
import { linkPreviewStale, parseLinkPreviewMeta, type LinkPreviewMeta } from "./lib/linkPreviewMeta";
import { fetchPublicPage } from "./lib/publicFetch";

// Link previews: a web link standing alone on its line in a message renders
// as a card drawn from the page's own meta tags. One row per URL, shared by
// every viewer and message; the card reads it with `get` and asks for a
// fetch with `request` when the row is missing or stale.

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

export const get = query({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const url = parseLinkPreviewUrl(args.url);
    if (!url) return null;
    const row = await ctx.db.query("link_previews").withIndex("by_url", (q) => q.eq("url", url)).first();
    if (!row) return null;
    const { _id, _creationTime, ...rest } = row;
    return rest;
  },
});

// Signed in only: the fetch runs from our servers, so an anonymous caller
// must not be able to point it at arbitrary pages.
export const request = mutation({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const url = parseLinkPreviewUrl(args.url);
    if (!url) return;
    const now = Date.now();
    const row = await ctx.db.query("link_previews").withIndex("by_url", (q) => q.eq("url", url)).first();
    if (!linkPreviewStale(row, now)) return;
    if (row) await ctx.db.patch(row._id, { status: row.status === "ok" ? "ok" : "pending", requested_at: now });
    else await ctx.db.insert("link_previews", { url, status: "pending", requested_at: now });
    await ctx.scheduler.runAfter(0, internal.linkPreviews.fetchPreview, { url });
  },
});

export const record = internalMutation({
  args: {
    url: v.string(),
    ok: v.boolean(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    site_name: v.optional(v.string()),
    favicon: v.optional(v.string()),
  },
  handler: async (ctx, { url, ok, ...meta }) => {
    const row = await ctx.db.query("link_previews").withIndex("by_url", (q) => q.eq("url", url)).first();
    if (!row) return;
    const now = Date.now();
    // A refetch that fails keeps the preview it already had.
    if (!ok && row.status === "ok") {
      await ctx.db.patch(row._id, { fetched_at: now });
      return;
    }
    await ctx.db.patch(row._id, {
      status: ok ? "ok" : "failed",
      title: meta.title,
      description: meta.description,
      image: meta.image,
      site_name: meta.site_name,
      favicon: meta.favicon,
      fetched_at: now,
    });
  },
});

/** The page's head. Every redirect hop passes the same public-host check as
 *  the link itself (lib/publicFetch). */
async function fetchHead(start: string): Promise<{ html: string; url: string } | null> {
  const page = await fetchPublicPage(start, {
    maxBytes: MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    headers: {
      // Many sites serve their tags only to a crawler they recognize.
      "User-Agent": "Mozilla/5.0 (compatible; CodecastBot/1.0; +https://codecast.sh) facebookexternalhit/1.1",
      Accept: "text/html,application/xhtml+xml",
    },
    accept: /html/i,
    stopAt: /<\/head\s*>|<body[\s>]/i,
  });
  return page ? { html: page.text, url: page.url } : null;
}

export const fetchPreview = internalAction({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    let meta: LinkPreviewMeta | null = null;
    try {
      const page = await fetchHead(url);
      if (page) meta = parseLinkPreviewMeta(page.html, page.url);
    } catch {
      meta = null;
    }
    const ok = !!meta?.title;
    const fields = ok ? Object.fromEntries(Object.entries(meta!).filter(([, v]) => v !== undefined)) : {};
    await ctx.runMutation(internal.linkPreviews.record, { url, ok, ...fields });
  },
});

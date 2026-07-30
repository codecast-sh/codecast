// Published HTML artifacts — `cast publish <file.html>` → https://codecast.sh/a/<slug>.
//
// Access model mirrors doc share links: the slug is an unguessable secret, so
// anyone holding the URL can view. The HTML body lives in Convex file storage
// (rows stay small, no document-size ceiling); the raw page is served by the
// GET /cli/a/<slug> HTTP action in http.ts, and the codecast.sh/a/<slug>
// wrapper page renders it in a sandboxed iframe with share controls.
//
// Publish identity: (user_id, source_path). Re-publishing the same file updates
// the same artifact in place — the URL is stable across revisions — unless the
// caller forces a fresh one (`cast publish --new`).

import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LENGTH = 12; // ~71 bits of entropy — the slug IS the access gate.

export function newSlug(): string {
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

function artifactUrl(slug: string): string {
  return `${process.env.SITE_URL || "https://codecast.sh"}/a/${slug}`;
}

function toCliRow(a: Doc<"artifacts">) {
  return {
    slug: a.slug,
    title: a.title,
    source_path: a.source_path,
    size: a.size,
    version: a.version,
    created_at: a.created_at,
    updated_at: a.updated_at,
    url: artifactUrl(a.slug),
  };
}

// Pre-check for the publish HTTP action: it must resolve the user BEFORE
// storing the blob, so an unauthorized call never leaves an orphaned storage
// object behind.
export const verify = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    return result ? { user_id: result.userId } : null;
  },
});

export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

// Called by the publish HTTP action after it has stored the blob. Updates the
// existing artifact for this (user, source_path) in place — deleting the
// superseded blob — or creates a new row.
export const upsertFromPublish = internalMutation({
  args: {
    user_id: v.id("users"),
    storage_id: v.id("_storage"),
    title: v.string(),
    size: v.number(),
    source_path: v.optional(v.string()),
    force_new: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing =
      !args.force_new && args.source_path
        ? await ctx.db
            .query("artifacts")
            .withIndex("by_user_path", (q) =>
              q.eq("user_id", args.user_id).eq("source_path", args.source_path),
            )
            .first()
        : null;

    const now = Date.now();

    if (existing) {
      const version = existing.version + 1;
      await ctx.storage.delete(existing.storage_id).catch(() => {});
      await ctx.db.patch(existing._id, {
        storage_id: args.storage_id,
        title: args.title,
        size: args.size,
        version,
        updated_at: now,
      });
      return { slug: existing.slug, url: artifactUrl(existing.slug), version, updated: true };
    }

    let slug = newSlug();
    // Collision is ~impossible at 71 bits, but a slug is a permanent public
    // URL — spend one read to keep it impossible.
    while (await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) {
      slug = newSlug();
    }

    await ctx.db.insert("artifacts", {
      slug,
      user_id: args.user_id,
      title: args.title,
      source_path: args.source_path,
      storage_id: args.storage_id,
      size: args.size,
      version: 1,
      created_at: now,
      updated_at: now,
    });
    return { slug, url: artifactUrl(slug), version: 1, updated: false };
  },
});

export const listFromCLI = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_user", (q) => q.eq("user_id", auth.userId))
      .collect();
    rows.sort((a, b) => b.updated_at - a.updated_at);
    return { artifacts: rows.map(toCliRow) };
  },
});

// `target` is a slug, an exact source path, or a path suffix (basename
// convenience: `cast publish rm report.html`). Suffix matches only win when
// unambiguous — otherwise the caller gets the candidates to pick from.
export const deleteFromCLI = mutation({
  args: { api_token: v.string(), target: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };

    const bySlugMatch = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.target))
      .first();

    let match = bySlugMatch && bySlugMatch.user_id === auth.userId ? bySlugMatch : null;

    if (!match) {
      const mine = await ctx.db
        .query("artifacts")
        .withIndex("by_user", (q) => q.eq("user_id", auth.userId))
        .collect();
      const suffix = args.target.startsWith("/") ? args.target : `/${args.target}`;
      const candidates = mine.filter(
        (a) => a.source_path === args.target || a.source_path?.endsWith(suffix),
      );
      if (candidates.length > 1) {
        // Folded into the error string because the CLI's cliPost helper prints
        // `error` and exits — structured extras would never reach the user.
        const listing = candidates.map((a) => `  ${a.slug}  ${a.title}`).join("\n");
        return {
          error: `"${args.target}" matches ${candidates.length} artifacts — use a slug:\n${listing}`,
        };
      }
      match = candidates[0] ?? null;
    }

    if (!match) return { error: `No artifact matches "${args.target}"` };

    await ctx.storage.delete(match.storage_id).catch(() => {});
    await ctx.db.delete(match._id);
    return { deleted: toCliRow(match) };
  },
});

// Viewer metadata for the codecast.sh/a/<slug> wrapper page and link unfurls.
// Content itself is served by the HTTP action; this exposes no more than the
// slug already grants.
export const getShared = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    return {
      slug: artifact.slug,
      title: artifact.title,
      size: artifact.size,
      version: artifact.version,
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
      user: user ? { name: user.name, image: user.image } : null,
    };
  },
});

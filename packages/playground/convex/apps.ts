// Apps: create (with its seed version and, from the home page, the first
// request), read by slug, and the home gallery ordered by recent activity.
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { GALLERY_MAX } from "./lib/limits";
import { seedFiles } from "./lib/seed";
import { cleanAppName, isSlug, makeSlug, nameFromPrompt } from "./lib/slugs";
import { cleanMessageBody } from "./lib/room";
import { appBySlug } from "./model";
import { hereRows } from "./presence";
import { takeRate } from "./limits";
import { appendVersion, versionByNumber } from "./versions";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { visitorArgs } from "./validators";

const SEED_SUMMARY = "Fresh clay";
const SLUG_ATTEMPTS = 5;
const GALLERY_FACES = 3;

async function freshSlug(ctx: QueryCtx, name: string): Promise<string> {
  for (let i = 0; i < SLUG_ATTEMPTS; i++) {
    const slug = makeSlug(name);
    if (!(await appBySlug(ctx, slug))) return slug;
  }
  throw new Error("could not find a free slug");
}

/** Make an app: v1 is the seed, live at once. A prompt (the home page's "Make
 *  something") also becomes the room's first message, a change request, and
 *  names the app unless a name is given. */
export const create = mutation({
  args: { ...visitorArgs, prompt: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    await takeRate(ctx, "createApp", visitor._id);
    const prompt = args.prompt === undefined ? null : cleanMessageBody(args.prompt);
    const name = cleanAppName(args.name) ?? (prompt ? nameFromPrompt(prompt) : "Untitled");
    const now = Date.now();
    const slug = await freshSlug(ctx, name);
    const appId = await ctx.db.insert("apps", {
      slug,
      name,
      live_version: 0,
      version_count: 0,
      contributor_count: 0,
      created_by: visitor._id,
      created_at: now,
      last_activity_at: now,
    });
    const app = (await ctx.db.get(appId))!;
    await appendVersion(ctx, app, { kind: "seed", summary: SEED_SUMMARY, author_id: visitor._id }, seedFiles(name));
    const request_message_id = prompt
      ? await ctx.db.insert("messages", { app_id: appId, kind: "request", visitor_id: visitor._id, body: prompt })
      : null;
    return { app_id: appId, slug, request_message_id };
  },
});

export type Lineage = { app_id: Id<"apps">; slug: string; name: string; version: number } | null;

async function lineage(ctx: QueryCtx, app: Doc<"apps">): Promise<Lineage> {
  if (!app.forked_from) return null;
  const source = await ctx.db.get(app.forked_from.app_id);
  return source ? { app_id: source._id, slug: source.slug, name: source.name, version: app.forked_from.version } : null;
}

export type AppView = {
  id: Id<"apps">;
  slug: string;
  name: string;
  live_version: number;
  version_count: number;
  contributor_count: number;
  created_by: PublicVisitor | null;
  created_at: number;
  last_activity_at: number;
  forked_from: Lineage;
  /** The live version's line for the clean link's toast and link unfurls. */
  live: { number: number; summary: string; created_at: number } | null;
};

/** An app by its link, or null when no app has that slug. */
export const get = query({
  args: { ...visitorArgs, slug: v.string() },
  handler: async (ctx, args): Promise<AppView | null> => {
    await requireVisitor(ctx, args);
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const [creator, live] = await Promise.all([
      publicVisitors(ctx, [app.created_by]),
      versionByNumber(ctx, app._id, app.live_version),
    ]);
    return {
      id: app._id,
      slug: app.slug,
      name: app.name,
      live_version: app.live_version,
      version_count: app.version_count,
      contributor_count: app.contributor_count,
      created_by: creator.get(app.created_by) ?? null,
      created_at: app.created_at,
      last_activity_at: app.last_activity_at,
      forked_from: await lineage(ctx, app),
      live: live && { number: live.number, summary: live.summary, created_at: live.created_at },
    };
  },
});

export type GalleryCard = {
  id: Id<"apps">;
  slug: string;
  name: string;
  live_version: number;
  contributor_count: number;
  last_activity_at: number;
  forked_from: Lineage;
  here_count: number;
  /** The first few people here, for the card's face stack. */
  here: PublicVisitor[];
};

/** The home gallery: most recently active apps first, with who is in each now,
 *  and the headline counts ("41 people building in 12 apps"). */
export const gallery = query({
  args: { ...visitorArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireVisitor(ctx, args);
    const limit = Math.max(1, Math.min(args.limit ?? GALLERY_MAX, GALLERY_MAX));
    const apps = await ctx.db.query("apps").withIndex("by_last_activity").order("desc").take(limit);
    const now = Date.now();
    const here = await Promise.all(apps.map((a) => hereRows(ctx, a._id, now)));
    const people = await publicVisitors(ctx, here.flatMap((rows) => rows.slice(0, GALLERY_FACES).map((r) => r.visitor_id)));
    const cards: GalleryCard[] = await Promise.all(
      apps.map(async (app, i) => ({
        id: app._id,
        slug: app.slug,
        name: app.name,
        live_version: app.live_version,
        contributor_count: app.contributor_count,
        last_activity_at: app.last_activity_at,
        forked_from: await lineage(ctx, app),
        here_count: here[i].length,
        here: here[i].slice(0, GALLERY_FACES).flatMap((r) => people.get(r.visitor_id) ?? []),
      })),
    );
    return {
      apps: cards,
      here_total: new Set(here.flat().map((r) => r.visitor_id)).size,
      active_apps: here.filter((rows) => rows.length > 0).length,
    };
  },
});


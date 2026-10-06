// Apps: create (with its seed version and, from the home page, the first
// request), read by slug, and the home gallery ordered by recent activity.
import { v } from "convex/values";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { GALLERY_MAX } from "./lib/limits";
import { seedFiles } from "./lib/seed";
import { cleanAppName, isSlug, makeSlug, nameFromPrompt } from "./lib/slugs";
import { cleanMessageBody } from "./lib/room";
import type { UnfurlApp } from "./lib/unfurl";
import { fail } from "./lib/errors";
import { appBySlug, postSystemNote, requireApp, touchApp } from "./model";
import { hereRows } from "./presence";
import { takeRate } from "./limits";
import { startDataCopy } from "./runtime";
import { appendCopiedVersion, appendVersion, versionByNumber } from "./versions";
import { buildRefusal, enqueueBuild } from "./builder/queue";
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

type NewApp = { name: string; created_by: Id<"visitors">; forked_from?: { app_id: Id<"apps">; version: number }; ideas?: string[] };

/** Insert an app row with no versions yet, at a fresh slug. */
async function insertApp(ctx: MutationCtx, fields: NewApp): Promise<Doc<"apps">> {
  const now = Date.now();
  const appId = await ctx.db.insert("apps", {
    slug: await freshSlug(ctx, fields.name),
    live_version: 0,
    version_count: 0,
    contributor_count: 0,
    created_at: now,
    last_activity_at: now,
    ...fields,
  });
  return (await ctx.db.get(appId))!;
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
    const app = await insertApp(ctx, { name, created_by: visitor._id });
    await appendVersion(ctx, app, { kind: "seed", summary: SEED_SUMMARY, author_id: visitor._id }, seedFiles(name));
    const request_message_id = prompt
      ? await ctx.db.insert("messages", { app_id: app._id, kind: "request", visitor_id: visitor._id, body: prompt })
      : null;
    if (request_message_id) await enqueueBuild(ctx, (await ctx.db.get(app._id))!, (await ctx.db.get(request_message_id))!, visitor._id);
    return { app_id: app._id, slug: app.slug, request_message_id };
  },
});

/** Fork from any version: a new app whose v1 holds that version's files, with
 *  a copy of the source's data, its own room and link. The source room hears
 *  about it, and each app links to the other. */
export const fork = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), number: v.number(), name: v.string() },
  handler: async (ctx, args): Promise<{ app_id: Id<"apps">; slug: string }> => {
    const visitor = await requireVisitor(ctx, args);
    const source = await requireApp(ctx, args.app_id);
    const from = (await versionByNumber(ctx, source._id, args.number)) ?? fail("not_found", `v${args.number} does not exist.`);
    const name = cleanAppName(args.name) ?? fail("invalid", "Give it a name first.");
    await takeRate(ctx, "createApp", visitor._id);
    const forked_from = { app_id: source._id, version: from.number };
    const app = await insertApp(ctx, { name, created_by: visitor._id, forked_from, ...(source.ideas ? { ideas: source.ideas } : {}) });
    await appendCopiedVersion(ctx, app, { kind: "fork", summary: from.summary, author_id: visitor._id, source: forked_from }, from);
    await startDataCopy(ctx, source._id, app._id);
    await postSystemNote(
      ctx,
      source._id,
      { type: "fork", visitor_id: visitor._id, version: from.number, fork_app_id: app._id },
      `v${from.number} forked into ${name}`,
    );
    await touchApp(ctx, source);
    return { app_id: app._id, slug: app.slug };
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
  /** Changes Clay suggests next, for the empty room. */
  ideas: string[];
  /** Why changes cannot build right now, in one line for people, or null. */
  builds_paused: string | null;
};

/** An app by its link, or null when no app has that slug. */
export const get = query({
  args: { ...visitorArgs, slug: v.string() },
  handler: async (ctx, args): Promise<AppView | null> => {
    await requireVisitor(ctx, args);
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const [creator, live, refusal] = await Promise.all([
      publicVisitors(ctx, [app.created_by]),
      versionByNumber(ctx, app._id, app.live_version),
      buildRefusal(ctx, app),
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
      ideas: app.ideas ?? [],
      builds_paused: refusal?.error ?? null,
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


/** What a link preview says about an app (http /og/<slug>). */
export const unfurl = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<UnfurlApp | null> => {
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const live = await versionByNumber(ctx, app._id, app.live_version);
    return { name: app.name, summary: live?.summary ?? null, version: app.live_version, contributors: app.contributor_count };
  },
});

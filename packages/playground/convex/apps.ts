// Apps: create (with its starter and, from the home page, the first
// request), read by slug, and the home gallery, busiest first.
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
import { presenceCutoff } from "./lib/presence";
import { versionSaid } from "./lib/versions";
import { stillUrl } from "./stills";
import { takeRate } from "./limits";
import { startDataCopy } from "./runtime";
import { appendCopiedVersion, appendVersion, shownVersion, versionByNumber } from "./versions";
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

/** Make an app, live at once on a starter. A prompt (the home page's "Make
 *  something") also becomes the room's first message, a change request, and
 *  names the app unless a name is given; the starter under it is then v0,
 *  scaffolding nobody sees, so the maker's first build is v1. Without one the
 *  starter is the app's v1. */
export const create = mutation({
  args: { ...visitorArgs, prompt: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    await takeRate(ctx, "createApp", visitor._id);
    const prompt = args.prompt === undefined ? null : cleanMessageBody(args.prompt);
    const name = cleanAppName(args.name) ?? (prompt ? nameFromPrompt(prompt) : "Untitled");
    const app = await insertApp(ctx, { name, created_by: visitor._id });
    await appendVersion(ctx, app, { kind: "seed", summary: SEED_SUMMARY, author_id: visitor._id, scaffold: prompt !== null }, seedFiles(name));
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
    const from = (await shownVersion(ctx, source._id, args.number)) ?? fail("not_found", `v${args.number} does not exist.`);
    const name = cleanAppName(args.name) ?? fail("invalid", "Give it a name first.");
    await takeRate(ctx, "createApp", visitor._id);
    const forked_from = { app_id: source._id, version: from.number };
    const app = await insertApp(ctx, { name, created_by: visitor._id, forked_from, ...(source.ideas ? { ideas: source.ideas } : {}) });
    await appendCopiedVersion(ctx, app, { kind: "fork", summary: from.summary, author_id: visitor._id, source: forked_from }, from);
    await startDataCopy(ctx, source._id, app._id, visitor._id);
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
  /** The live version's line for the clean link's toast and link unfurls,
   *  and whether the gallery has its picture yet. */
  live: { number: number; summary: string; created_at: number; author_id: Id<"visitors">; has_still: boolean } | null;
  /** Changes Clay suggests next, for the empty room. */
  ideas: string[];
  /** Why your changes cannot build right now, in one line for people, or null. */
  builds_paused: string | null;
};

/** An app by its link, or null when no app has that slug. */
export const get = query({
  args: { ...visitorArgs, slug: v.string() },
  handler: async (ctx, args): Promise<AppView | null> => {
    const visitor = await requireVisitor(ctx, args);
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const [creator, live, refusal] = await Promise.all([
      publicVisitors(ctx, [app.created_by]),
      shownVersion(ctx, app._id, app.live_version),
      buildRefusal(ctx, app, visitor._id),
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
      live: live && { number: live.number, summary: live.summary, created_at: live.created_at, author_id: live.author_id, has_still: !!live.still },
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
  last_activity_at: number;
  /** The live version's picture, or null until a screen has taken one. */
  still_url: string | null;
  /** What made the live version, so two apps with one name still read apart. */
  latest: { by: PublicVisitor | null; at: number; said: string } | null;
  here_count: number;
  /** The first few people here, for the card's face stack. */
  here: PublicVisitor[];
};

/** How many people a gallery reads presence from to find busy apps. */
const BUSY_SCAN = 500;

/** The home gallery: apps with people in them first, the busiest first, then
 *  the most recently active, with who is in each now and the headline
 *  counts ("41 people building in 12 apps"). An app still waiting for its
 *  first build has nothing to show yet, so it waits too; a fork nobody has
 *  changed is its source over again, so it shows only while someone is in it. */
export const gallery = query({
  args: { ...visitorArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireVisitor(ctx, args);
    const limit = Math.max(1, Math.min(args.limit ?? GALLERY_MAX, GALLERY_MAX));
    const now = Date.now();
    const recent = await ctx.db.query("apps").withIndex("by_last_activity").order("desc").take(limit);
    const present = await ctx.db.query("presence").withIndex("by_seen", (q) => q.gt("last_seen", presenceCutoff(now))).take(BUSY_SCAN);
    const known = new Set(recent.map((a) => a._id));
    const busy = await Promise.all([...new Set(present.map((p) => p.app_id))].filter((id) => !known.has(id)).map((id) => ctx.db.get(id)));
    const apps = [...recent, ...busy.flatMap((a) => (a ? [a] : []))];
    const here = new Map(await Promise.all(apps.map(async (a) => [a._id, await hereRows(ctx, a._id, now)] as const)));
    const ranked = apps
      .filter((a) => a.live_version > 0 && (here.get(a._id)!.length > 0 || !(a.forked_from && a.version_count === 1)))
      .sort((a, b) => here.get(b._id)!.length - here.get(a._id)!.length || b.last_activity_at - a.last_activity_at)
      .slice(0, limit);
    const live = await Promise.all(ranked.map((a) => shownVersion(ctx, a._id, a.live_version)));
    const people = await publicVisitors(ctx, [
      ...ranked.flatMap((a) => here.get(a._id)!.slice(0, GALLERY_FACES).map((r) => r.visitor_id)),
      ...live.flatMap((l) => (l ? [l.author_id] : [])),
    ]);
    const cards: GalleryCard[] = await Promise.all(
      ranked.map(async (app, i) => {
        const l = live[i];
        const rows = here.get(app._id)!;
        const source = l?.kind === "fork" ? await lineage(ctx, app) : null;
        return {
          id: app._id,
          slug: app.slug,
          name: app.name,
          live_version: app.live_version,
          last_activity_at: app.last_activity_at,
          still_url: await stillUrl(ctx, l),
          latest: l && { by: people.get(l.author_id) ?? null, at: l.created_at, said: versionSaid(l, source?.name ?? null) },
          here_count: rows.length,
          here: rows.slice(0, GALLERY_FACES).flatMap((r) => people.get(r.visitor_id) ?? []),
        };
      }),
    );
    const counts = [...here.values()];
    return {
      apps: cards,
      here_total: new Set(counts.flat().map((r) => r.visitor_id)).size,
      active_apps: counts.filter((rows) => rows.length > 0).length,
    };
  },
});

/** What a link preview says about an app (http /og/<slug>). */
export const unfurl = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<UnfurlApp | null> => {
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const live = await shownVersion(ctx, app._id, app.live_version);
    return { name: app.name, summary: live?.summary ?? null, version: app.live_version, contributors: app.contributor_count, image: await stillUrl(ctx, live) };
  },
});

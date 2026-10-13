// Apps: create (with its starter and, from the home page, the first
// request), read by slug, and the home gallery, busiest first.
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { GALLERY_MAX } from "./lib/limits";
import { seedFiles } from "./lib/seed";
import { cleanAppName, isSlug, makeSlug, nameFromPrompt } from "./lib/slugs";
import { cleanMessageBody } from "./lib/room";
import type { UnfurlApp } from "./lib/unfurl";
import { fail } from "./lib/errors";
import { appBySlug, postSystemNote, requireApp, touchApp } from "./model";
import { crowdRow } from "./presence";
import { versionSaid } from "./lib/versions";
import { stillUrl } from "./stills";
import { takeRate } from "./limits";
import { startDataCopy } from "./runtime";
import { appendCopiedVersion, appendVersion, shownVersion, versionByNumber } from "./versions";
import { enqueueBuild, shownRefusal } from "./builder/queue";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { visitorArgs } from "./validators";

const SEED_SUMMARY = "Fresh clay";
const SLUG_ATTEMPTS = 5;

async function freshSlug(ctx: QueryCtx, name: string): Promise<string> {
  for (let i = 0; i < SLUG_ATTEMPTS; i++) {
    const slug = makeSlug(name);
    if (!(await appBySlug(ctx, slug))) return slug;
  }
  throw new Error("could not find a free slug");
}

type NewApp = Pick<Doc<"apps">, "name" | "created_by" | "forked_from" | "ideas" | "unlisted">;

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
  args: { ...visitorArgs, prompt: v.optional(v.string()), name: v.optional(v.string()), unlisted: v.optional(v.literal(true)) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    await takeRate(ctx, "createApp", visitor._id);
    const prompt = args.prompt === undefined ? null : cleanMessageBody(args.prompt);
    const name = cleanAppName(args.name) ?? (prompt ? nameFromPrompt(prompt) : "Untitled");
    const app = await insertApp(ctx, { name, created_by: visitor._id, unlisted: args.unlisted });
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
    const app = await insertApp(ctx, { name, created_by: visitor._id, forked_from, ideas: source.ideas, unlisted: source.unlisted });
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
  created_by: PublicVisitor | null;
  created_at: number;
  forked_from: Lineage;
  /** The live version's line for the clean link's toast and link unfurls,
   *  and whether the gallery has its picture yet. */
  live: { number: number; summary: string; created_at: number; author_id: Id<"visitors">; has_still: boolean } | null;
  /** Changes Clay suggests next, for the empty room. */
  ideas: string[];
};

/** An app by its link, or null when no app has that slug. Public, so the
 *  app's page can draw before its visitor is known, and only facts that
 *  change with the app itself: a message or a charge anywhere wakes nobody's
 *  page (activity times, budgets and the room each have their own read). */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, args): Promise<AppView | null> => {
    const app = isSlug(args.slug) ? await appBySlug(ctx, args.slug) : null;
    if (!app) return null;
    const [creator, live] = await Promise.all([publicVisitors(ctx, [app.created_by]), shownVersion(ctx, app._id, app.live_version)]);
    return {
      id: app._id,
      slug: app.slug,
      name: app.name,
      live_version: app.live_version,
      version_count: app.version_count,
      created_by: creator.get(app.created_by) ?? null,
      created_at: app.created_at,
      forked_from: await lineage(ctx, app),
      live: live && { number: live.number, summary: live.summary, created_at: live.created_at, author_id: live.author_id, has_still: !!live.still },
      ideas: app.ideas ?? [],
    };
  },
});

/** Why your changes in this app cannot build right now, in one line for
 *  people, or null. Changes only when building is switched off or on, or a
 *  budget is used up or freed (builder/queue shownRefusal). */
export const buildsPaused = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<string | null> => {
    const visitor = await requireVisitor(ctx, args);
    return (await shownRefusal(ctx, args.app_id, visitor._id))?.error ?? null;
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

/** How many busy apps a gallery reads. */
const BUSY_SCAN = 200;
/** Recent apps read per tile, so near-copies folding together still fill it. */
const RECENT_PER_TILE = 3;

/** One tile per name and maker: a burst of near-copies (one person making
 *  the same app again and again) is one app on the home page, its best. */
function oneOfEach(apps: Doc<"apps">[]): Doc<"apps">[] {
  const seen = new Set<string>();
  return apps.filter((a) => {
    const key = `${a.created_by}:${a.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The home gallery (public, like everything it shows, so the home page
 *  draws before its visitor is known): apps with people in them first, the busiest first, then
 *  the most recently active, with who is in each now and the headline
 *  counts ("41 people building in 12 apps"). An app still waiting for its
 *  first build has nothing to show yet, so it waits too; a fork nobody has
 *  changed is its source over again, so it shows only while someone is in it.
 *  Unlisted apps never show, and near-copies show once (oneOfEach).
 *  Who is where comes from each app's crowd, which changes only when someone
 *  arrives or leaves, so heartbeats never re-run this. */
export const gallery = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? GALLERY_MAX, GALLERY_MAX));
    const recent = await ctx.db
      .query("apps")
      .withIndex("by_listed_activity", (q) => q.eq("unlisted", undefined))
      .order("desc")
      .take(limit * RECENT_PER_TILE);
    const busy = await ctx.db.query("crowds").withIndex("by_count", (q) => q.gt("count", 0)).order("desc").take(BUSY_SCAN);
    const known = new Set(recent.map((a) => a._id));
    const more = await Promise.all(busy.filter((c) => !known.has(c.app_id)).map((c) => ctx.db.get(c.app_id)));
    const apps = [...recent, ...more.flatMap((a) => (a ? [a] : []))];
    const crowdOf = new Map(busy.map((c) => [c.app_id, c]));
    const missing = await Promise.all(apps.filter((a) => !crowdOf.has(a._id)).map((a) => crowdRow(ctx, a._id)));
    for (const c of missing) if (c) crowdOf.set(c.app_id, c);
    const count = (a: Doc<"apps">) => crowdOf.get(a._id)?.count ?? 0;
    const ranked = oneOfEach(
      apps
        .filter((a) => !a.unlisted && a.live_version > 0 && (count(a) > 0 || !(a.forked_from && a.version_count === 1)))
        .sort((a, b) => count(b) - count(a) || b.last_activity_at - a.last_activity_at),
    ).slice(0, limit);
    const live = await Promise.all(ranked.map((a) => shownVersion(ctx, a._id, a.live_version)));
    const people = await publicVisitors(ctx, [
      ...ranked.flatMap((a) => crowdOf.get(a._id)?.faces ?? []),
      ...live.flatMap((l) => (l ? [l.author_id] : [])),
    ]);
    const cards: GalleryCard[] = await Promise.all(
      ranked.map(async (app, i) => {
        const l = live[i];
        const source = l?.kind === "fork" ? await lineage(ctx, app) : null;
        return {
          id: app._id,
          slug: app.slug,
          name: app.name,
          live_version: app.live_version,
          last_activity_at: app.last_activity_at,
          still_url: await stillUrl(ctx, l),
          latest: l && { by: people.get(l.author_id) ?? null, at: l.created_at, said: versionSaid(l, source?.name ?? null) },
          here_count: count(app),
          here: (crowdOf.get(app._id)?.faces ?? []).flatMap((id) => people.get(id) ?? []),
        };
      }),
    );
    const crowds = [...crowdOf.values()];
    return {
      apps: cards,
      here_total: crowds.reduce((n, c) => n + c.count, 0),
      active_apps: crowds.filter((c) => c.count > 0).length,
    };
  },
});

/** Take apps off the home page (a harness's leftovers, or one taken down);
 *  their links keep working. */
export const unlist = internalMutation({
  args: { slugs: v.array(v.string()) },
  handler: async (ctx, args) => {
    for (const slug of args.slugs) {
      const app = await appBySlug(ctx, slug);
      if (app) await ctx.db.patch(app._id, { unlisted: true });
    }
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

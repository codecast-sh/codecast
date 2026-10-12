// Who is in an app now (lib/presence for the rules). A page beats while open,
// says when its visitor is typing, and leaves on pagehide; the prune cron
// deletes rows nobody renewed, which is also what wakes subscribers when a
// tab closes without saying goodbye. Two things are kept beside the rows so
// their readers never wake for a heartbeat: each app's crowd (how many are
// in it and the first few faces, changed only by an arrival or a departure)
// for the gallery, and who is typing, for the room.
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { HERE_MAX } from "./lib/limits";
import { PRESENCE, heartbeatPatch, presenceCutoff } from "./lib/presence";
import { takeRate } from "./limits";
import { requireApp } from "./model";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { visitorArgs } from "./validators";

const PRUNE_BATCH = 200;
/** The faces a crowd keeps, for the gallery's face stack. */
export const CROWD_FACES = 3;

export function presenceRow(ctx: QueryCtx, appId: Id<"apps">, visitorId: Id<"visitors">) {
  return ctx.db
    .query("presence")
    .withIndex("by_app_visitor", (q) => q.eq("app_id", appId).eq("visitor_id", visitorId))
    .unique();
}

/** The presence rows of an app still inside the stale window, earliest
 *  arrival first: the HERE_MAX most recently seen. */
export async function hereRows(ctx: QueryCtx, appId: Id<"apps">, now = Date.now()): Promise<Doc<"presence">[]> {
  const rows = await ctx.db
    .query("presence")
    .withIndex("by_app_seen", (q) => q.eq("app_id", appId).gt("last_seen", presenceCutoff(now)))
    .order("desc")
    .take(HERE_MAX);
  return rows.sort((a, b) => a.joined_at - b.joined_at);
}

export function crowdRow(ctx: QueryCtx, appId: Id<"apps">) {
  return ctx.db.query("crowds").withIndex("by_app", (q) => q.eq("app_id", appId)).unique();
}

/** Keep an app's crowd in step with an arrival or a departure. A departure
 *  of one of its faces takes the next earliest arrival's in its place. */
async function recount(ctx: MutationCtx, appId: Id<"apps">, visitorId: Id<"visitors">, delta: 1 | -1): Promise<void> {
  const crowd = await crowdRow(ctx, appId);
  const count = Math.max(0, (crowd?.count ?? 0) + delta);
  let faces = crowd?.faces ?? [];
  if (delta > 0 && faces.length < CROWD_FACES && !faces.includes(visitorId)) faces = [...faces, visitorId];
  if (delta < 0 && faces.includes(visitorId)) {
    const rest = await ctx.db.query("presence").withIndex("by_app_visitor", (q) => q.eq("app_id", appId)).take(HERE_MAX);
    faces = rest
      .filter((r) => r.visitor_id !== visitorId)
      .sort((a, b) => a.joined_at - b.joined_at)
      .slice(0, CROWD_FACES)
      .map((r) => r.visitor_id);
  }
  if (!crowd) await ctx.db.insert("crowds", { app_id: appId, count, faces });
  else if (count === 0) await ctx.db.delete(crowd._id);
  else await ctx.db.patch(crowd._id, { count, faces });
}

/** A visitor arrives in an app. */
export async function insertPresence(
  ctx: MutationCtx,
  appId: Id<"apps">,
  visitorId: Id<"visitors">,
  now: number,
  fields: Partial<Pick<Doc<"presence">, "viewing_version" | "state">> = {},
): Promise<Id<"presence">> {
  const id = await ctx.db.insert("presence", {
    app_id: appId,
    visitor_id: visitorId,
    joined_at: now,
    last_seen: now,
    viewing_version: null,
    ...fields,
  });
  await recount(ctx, appId, visitorId, 1);
  return id;
}

/** A visitor leaves an app, saying so or lapsing. */
async function removePresence(ctx: MutationCtx, row: Doc<"presence">): Promise<void> {
  await ctx.db.delete(row._id);
  await recount(ctx, row.app_id, row.visitor_id, -1);
  await stopTyping(ctx, row.app_id, row.visitor_id);
}

function typingRow(ctx: QueryCtx, appId: Id<"apps">, visitorId: Id<"visitors">) {
  return ctx.db
    .query("typing")
    .withIndex("by_app_visitor", (q) => q.eq("app_id", appId).eq("visitor_id", visitorId))
    .unique();
}

/** Clear a visitor's typing indicator in an app, if it is up. */
export async function stopTyping(ctx: MutationCtx, appId: Id<"apps">, visitorId: Id<"visitors">): Promise<void> {
  const row = await typingRow(ctx, appId, visitorId);
  if (row) await ctx.db.delete(row._id);
}

/** Renew this visitor's place in the app; also how the page says which
 *  version it is looking at (null for live). Beat every PRESENCE.heartbeatMs. */
export const heartbeat = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), viewing_version: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    await requireApp(ctx, args.app_id);
    const now = Date.now();
    const viewing = args.viewing_version ?? null;
    const row = await presenceRow(ctx, args.app_id, visitor._id);
    const patch = row && heartbeatPatch(row, viewing, now);
    // Only beats that write count: an idle room's skipped beats stay free.
    if (!row || patch) await takeRate(ctx, "presence", visitor._id);
    if (!row) {
      await insertPresence(ctx, args.app_id, visitor._id, now, { viewing_version: viewing });
    } else if (patch) {
      await ctx.db.patch(row._id, row.last_seen > presenceCutoff(now) ? patch : { ...patch, joined_at: now });
    }
    return null;
  },
});

/** Typing on (call again while typing, every few seconds) or off. */
export const setTyping = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), typing: v.boolean() },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    if (!args.typing || !(await presenceRow(ctx, args.app_id, visitor._id))) {
      await stopTyping(ctx, args.app_id, visitor._id);
      return null;
    }
    await takeRate(ctx, "presence", visitor._id);
    const until = Date.now() + PRESENCE.typingMs;
    const row = await typingRow(ctx, args.app_id, visitor._id);
    if (row) await ctx.db.patch(row._id, { until });
    else await ctx.db.insert("typing", { app_id: args.app_id, visitor_id: visitor._id, until });
    return null;
  },
});

export const leave = mutation({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    const row = await presenceRow(ctx, args.app_id, visitor._id);
    if (row) await removePresence(ctx, row);
    return null;
  },
});

/** Who is here: who they are and what they look at, nothing that a beat
 *  renews, so a beat re-runs this query to the same answer and wakes nobody. */
export type HereEntry = {
  visitor: PublicVisitor;
  viewing_version: number | null;
};

/** Who is here now, earliest arrival first. */
export const here = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<HereEntry[]> => {
    await requireVisitor(ctx, args);
    const rows = await hereRows(ctx, args.app_id);
    const people = await publicVisitors(ctx, rows.map((r) => r.visitor_id));
    return rows.flatMap((r) => {
      const visitor = people.get(r.visitor_id);
      return visitor ? [{ visitor, viewing_version: r.viewing_version }] : [];
    });
  },
});

/** Who said they are typing in an app, and until when: compare with your
 *  clock, since nothing writes when a deadline passes. */
export const typing = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<{ visitor_id: Id<"visitors">; until: number }[]> => {
    await requireVisitor(ctx, args);
    const rows = await ctx.db.query("typing").withIndex("by_app_visitor", (q) => q.eq("app_id", args.app_id)).take(HERE_MAX);
    return rows.map((r) => ({ visitor_id: r.visitor_id, until: r.until }));
  },
});

/** Delete presence nobody renewed. Runs every minute (crons.ts). */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("presence")
      .withIndex("by_seen", (q) => q.lte("last_seen", presenceCutoff(Date.now())))
      .take(PRUNE_BATCH);
    for (const row of stale) await removePresence(ctx, row);
    return stale.length;
  },
});

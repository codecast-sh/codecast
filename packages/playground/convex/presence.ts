// Who is in an app now (lib/presence for the rules). A page beats while open,
// says when its visitor is typing, and leaves on pagehide; the prune cron
// deletes rows nobody renewed, which is also what wakes subscribers when a
// tab closes without saying goodbye.
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { HERE_MAX } from "./lib/limits";
import { PRESENCE, heartbeatPatch, isTyping, presenceCutoff } from "./lib/presence";
import { takeRate } from "./limits";
import { requireApp } from "./model";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { visitorArgs } from "./validators";

const PRUNE_BATCH = 200;

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

/** A visitor arrives in an app. */
export async function insertPresence(
  ctx: MutationCtx,
  appId: Id<"apps">,
  visitorId: Id<"visitors">,
  now: number,
  fields: Partial<Pick<Doc<"presence">, "viewing_version" | "state">> = {},
): Promise<Id<"presence">> {
  return ctx.db.insert("presence", {
    app_id: appId,
    visitor_id: visitorId,
    joined_at: now,
    last_seen: now,
    typing_until: 0,
    viewing_version: null,
    ...fields,
  });
}

/** Clear a visitor's typing indicator in an app, if it is up. */
export async function stopTyping(ctx: MutationCtx, appId: Id<"apps">, visitorId: Id<"visitors">): Promise<void> {
  const row = await presenceRow(ctx, appId, visitorId);
  if (row && isTyping(row, Date.now())) await ctx.db.patch(row._id, { typing_until: 0 });
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
    // Only beats that write count: an idle room's beats stay free.
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
    if (args.typing) {
      const row = await presenceRow(ctx, args.app_id, visitor._id);
      if (row) {
        await takeRate(ctx, "presence", visitor._id);
        await ctx.db.patch(row._id, { typing_until: Date.now() + PRESENCE.typingMs });
      }
    } else {
      await stopTyping(ctx, args.app_id, visitor._id);
    }
    return null;
  },
});

export const leave = mutation({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    const row = await presenceRow(ctx, args.app_id, visitor._id);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** Who is here, without when they last beat: a beat that only renews
 *  someone's place re-runs this query to the same answer, so nobody's page
 *  wakes for it. */
export type HereEntry = {
  visitor: PublicVisitor;
  /** Compare with your clock: typing until then unless a later write says otherwise. */
  typing_until: number;
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
      return visitor
        ? [{ visitor, typing_until: r.typing_until, viewing_version: r.viewing_version }]
        : [];
    });
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
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

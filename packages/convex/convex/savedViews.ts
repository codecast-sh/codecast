import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isTeamMember } from "./privacy";

/**
 * Saved list views. A view is a named set of filters/grouping/sort for a list
 * page, and — unlike the client_state bag these used to live in — a view here
 * can be SHARED, so one person's tuning shows up on the whole team's rail.
 *
 * Access is one rule, applied on every read and write: you own it, or it is
 * shared with a team you belong to. Sharing is the only thing that widens a
 * view's audience, and only the owner can turn it on.
 */

// "workspace" is the layout workbenches: a view of the chrome arrangement
// itself (which rails/panels are open, how wide) rather than of a list page.
const PAGE = v.union(v.literal("tasks"), v.literal("docs"), v.literal("plans"), v.literal("workspace"));

/** Owner, or a member of the team a SHARED view belongs to. A private view is
 *  owner-only no matter which team it is tagged with. */
async function canRead(ctx: any, userId: string, row: any): Promise<boolean> {
  if (!row) return false;
  if (String(row.user_id) === String(userId)) return true;
  if (!row.shared || !row.team_id) return false;
  return await isTeamMember(ctx, userId as any, row.team_id);
}

/** Every view this user can see: their own, plus their teams' shared ones. */
export const webList = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const mine = await ctx.db
      .query("saved_views")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();

    let shared: any[] = [];
    if (args.team_id && (await isTeamMember(ctx, userId, args.team_id))) {
      const teamRows = await ctx.db
        .query("saved_views")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id!))
        .collect();
      // A teammate's row only surfaces once they share it; own rows already
      // came from `mine`, so drop them here rather than returning duplicates.
      shared = teamRows.filter(
        (r: any) => r.shared && String(r.user_id) !== String(userId)
      );
    }

    const rows = [...mine, ...shared];
    // Name the author so the rail can say whose view a shared one is.
    const owners = new Map<string, any>();
    for (const row of rows) {
      const key = String(row.user_id);
      if (!owners.has(key)) owners.set(key, await ctx.db.get(row.user_id));
    }
    return rows.map((row: any) => {
      const owner = owners.get(String(row.user_id));
      return {
        ...row,
        owner_name: owner?.name ?? owner?.email ?? undefined,
        owner_image: owner?.image ?? undefined,
        is_mine: String(row.user_id) === String(userId),
      };
    });
  },
});

export const webCreate = mutation({
  args: {
    name: v.string(),
    page: PAGE,
    prefs: v.any(),
    team_id: v.optional(v.id("teams")),
    shared: v.optional(v.boolean()),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Idempotency: a retried create (timeout after commit, replayed outbox)
    // returns the row it already made instead of a second copy.
    if (args.client_key) {
      const existing = await ctx.db
        .query("saved_views")
        .withIndex("by_client_key", (q: any) => q.eq("client_key", args.client_key))
        .first();
      if (existing && String(existing.user_id) === String(userId)) return existing._id;
    }

    // Sharing with nobody is not a state worth storing: a shared view needs a
    // team to be shared WITH, and you must belong to it.
    let shared = args.shared === true;
    if (shared && (!args.team_id || !(await isTeamMember(ctx, userId, args.team_id)))) {
      shared = false;
    }

    const now = Date.now();
    return await ctx.db.insert("saved_views", {
      user_id: userId,
      team_id: args.team_id,
      name: args.name.trim() || "Untitled view",
      page: args.page,
      prefs: args.prefs ?? {},
      shared,
      icon: args.icon,
      color: args.color,
      client_key: args.client_key,
      created_at: now,
      updated_at: now,
    });
  },
});

export const webUpdate = mutation({
  args: {
    id: v.id("saved_views"),
    name: v.optional(v.string()),
    prefs: v.optional(v.any()),
    shared: v.optional(v.boolean()),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const row = await ctx.db.get(args.id);
    // Editing is the owner's alone. A teammate who wants their own tuning of a
    // shared view can save a copy — silently rewriting it under everyone else
    // is the behaviour that makes shared views untrustworthy.
    if (!row || String(row.user_id) !== String(userId)) throw new Error("Not found");

    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (args.name !== undefined) patch.name = args.name.trim() || "Untitled view";
    if (args.prefs !== undefined) patch.prefs = args.prefs;
    if (args.icon !== undefined) patch.icon = args.icon;
    if (args.color !== undefined) patch.color = args.color;
    if (args.team_id !== undefined) patch.team_id = args.team_id;

    if (args.shared !== undefined) {
      const teamId = (args.team_id ?? row.team_id) as any;
      patch.shared =
        args.shared === true && !!teamId && (await isTeamMember(ctx, userId, teamId));
    }
    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});

export const webDelete = mutation({
  args: { id: v.id("saved_views") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const row = await ctx.db.get(args.id);
    if (!row || String(row.user_id) !== String(userId)) throw new Error("Not found");
    await ctx.db.delete(args.id);
    return true;
  },
});

/** One view by id — used when a shared link names a view directly. */
export const webGet = query({
  args: { id: v.id("saved_views") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db.get(args.id);
    return (await canRead(ctx, userId, row)) ? row : null;
  },
});

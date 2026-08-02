import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// One-time repair for the 2026-08-02 Steering workspace routing incident:
// portfolio conversations inherited the active repo's team (Codecast) instead
// of the viewer's selected workspace, stranding early Steering rows where the
// Steering tab couldn't see them. Moves the named rows into the intended team
// and deletes explicitly listed test artifacts. Run once via
// `npx convex run migrations_steeringWorkspaceMove:run '{...}'`, then leave in
// place as a record; it is inert without arguments.
export const run = internalMutation({
  args: {
    to_team_id: v.id("teams"),
    proposal_short_ids: v.optional(v.array(v.string())),
    item_short_ids: v.optional(v.array(v.string())),
    delete_item_short_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const moved: string[] = [];
    const deleted: string[] = [];
    const now = Date.now();
    for (const short_id of args.proposal_short_ids ?? []) {
      const row = await ctx.db
        .query("steering_proposals")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", short_id))
        .unique();
      if (!row) throw new Error(`proposal ${short_id} not found`);
      await ctx.db.patch(row._id, { team_id: args.to_team_id, updated_at: now });
      moved.push(short_id);
    }
    for (const short_id of args.item_short_ids ?? []) {
      const row = await ctx.db
        .query("steering_items")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", short_id))
        .unique();
      if (!row) throw new Error(`item ${short_id} not found`);
      await ctx.db.patch(row._id, { team_id: args.to_team_id, updated_at: now });
      moved.push(short_id);
    }
    for (const short_id of args.delete_item_short_ids ?? []) {
      const row = await ctx.db
        .query("steering_items")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", short_id))
        .unique();
      if (!row) continue;
      const children = await ctx.db
        .query("steering_items")
        .withIndex("by_parent_item_id", (q: any) => q.eq("parent_item_id", row._id))
        .collect();
      if (children.length) throw new Error(`item ${short_id} has children; refusing to delete`);
      await ctx.db.delete(row._id);
      deleted.push(short_id);
    }
    return { moved, deleted };
  },
});

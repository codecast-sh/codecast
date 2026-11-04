// Where a deploy lives, by its dp-N (deploys.md DP12): the team, target and
// repository the Deploys page opens on when a dp-N pill is followed from a
// team the viewer is not looking at.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { workspaceGrantsAccess } from "./lib/access";

export const whereIs = query({
  args: { ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const d = await ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", args.ref.trim().toLowerCase())).first();
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) return null;
    return { team_id: d.workspace.startsWith("team:") ? d.workspace.slice(5) : null, target: d.target, repository: d.repository ?? null };
  },
});

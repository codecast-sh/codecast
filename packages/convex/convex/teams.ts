import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export const createTeam = mutation({
  args: {
    name: v.string(),
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const inviteCode = generateInviteCode();
    const teamId = await ctx.db.insert("teams", {
      name: args.name,
      created_at: Date.now(),
      invite_code: inviteCode,
    });
    await ctx.db.patch(args.user_id, {
      team_id: teamId,
      role: "admin",
    });
    return teamId;
  },
});

export const joinTeam = mutation({
  args: {
    invite_code: v.string(),
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_invite_code", (q) => q.eq("invite_code", args.invite_code))
      .unique();
    if (!team) {
      throw new Error("Invalid invite code");
    }
    await ctx.db.patch(args.user_id, {
      team_id: team._id,
      role: "member",
    });
    return team._id;
  },
});

export const getTeamMembers = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.team_id?.toString() === args.team_id.toString())
      .map((u) => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        role: u.role,
        daemon_last_seen: u.daemon_last_seen,
      }));
  },
});

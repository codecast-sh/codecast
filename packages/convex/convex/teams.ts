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
    const now = Date.now();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    const teamId = await ctx.db.insert("teams", {
      name: args.name,
      created_at: now,
      invite_code: inviteCode,
      invite_code_expires_at: now + sevenDaysInMs,
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
    if (team.invite_code_expires_at && Date.now() > team.invite_code_expires_at) {
      throw new Error("Invite code expired");
    }
    await ctx.db.patch(args.user_id, {
      team_id: team._id,
      role: "member",
    });
    return team._id;
  },
});

export const getTeam = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.team_id);
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

export const removeMember = mutation({
  args: {
    requesting_user_id: v.id("users"),
    member_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    if (requestingUser.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    if (args.requesting_user_id === args.member_user_id) {
      const teamMembers = await ctx.db.query("users").collect();
      const adminCount = teamMembers.filter(
        (u) => u.team_id?.toString() === requestingUser.team_id?.toString() && u.role === "admin"
      ).length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    await ctx.db.patch(args.member_user_id, {
      team_id: undefined,
      role: undefined,
    });
  },
});

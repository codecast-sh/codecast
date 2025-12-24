import { mutation, query, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

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

export const getTeamByInviteCode = query({
  args: {
    invite_code: v.string(),
  },
  handler: async (ctx, args) => {
    const team = await ctx.db
      .query("teams")
      .withIndex("by_invite_code", (q) => q.eq("invite_code", args.invite_code))
      .unique();

    if (!team) {
      return null;
    }

    const members = await ctx.db.query("users").collect();
    const memberCount = members.filter(
      (u) => u.team_id?.toString() === team._id.toString()
    ).length;

    const isExpired = !!(team.invite_code_expires_at && Date.now() > team.invite_code_expires_at);

    return {
      _id: team._id,
      name: team.name,
      memberCount,
      isExpired,
    };
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
        github_username: u.github_username,
        github_avatar_url: u.github_avatar_url,
        title: u.title,
        bio: u.bio,
        status: u.status,
        timezone: u.timezone,
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

export const renameTeam = mutation({
  args: {
    team_id: v.id("teams"),
    requesting_user_id: v.id("users"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser || requestingUser.role !== "admin") {
      throw new Error("Only admins can rename the team");
    }
    if (requestingUser.team_id?.toString() !== args.team_id.toString()) {
      throw new Error("Not a member of this team");
    }
    await ctx.db.patch(args.team_id, { name: args.name.trim() });
  },
});

export const inviteToTeam = mutation({
  args: {
    team_id: v.id("teams"),
    requesting_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser || requestingUser.role !== "admin") {
      throw new Error("Only admins can generate invite codes");
    }
    if (requestingUser.team_id?.toString() !== args.team_id.toString()) {
      throw new Error("Not a member of this team");
    }
    const newCode = generateInviteCode();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    await ctx.db.patch(args.team_id, {
      invite_code: newCode,
      invite_code_expires_at: Date.now() + sevenDaysInMs,
    });
    return newCode;
  },
});

export const regenerateInviteCode = mutation({
  args: {
    team_id: v.id("teams"),
    requesting_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser || requestingUser.role !== "admin") {
      throw new Error("Only admins can regenerate invite codes");
    }
    if (requestingUser.team_id?.toString() !== args.team_id.toString()) {
      throw new Error("Not a member of this team");
    }
    const newCode = generateInviteCode();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    await ctx.db.patch(args.team_id, {
      invite_code: newCode,
      invite_code_expires_at: Date.now() + sevenDaysInMs,
    });
    return newCode;
  },
});

export const setMemberRole = mutation({
  args: {
    requesting_user_id: v.id("users"),
    member_user_id: v.id("users"),
    role: v.union(v.literal("member"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser || requestingUser.role !== "admin") {
      throw new Error("Only admins can change member roles");
    }
    const memberUser = await ctx.db.get(args.member_user_id);
    if (!memberUser || memberUser.team_id?.toString() !== requestingUser.team_id?.toString()) {
      throw new Error("User not in your team");
    }
    if (args.role === "member" && memberUser.role === "admin") {
      const teamMembers = await ctx.db.query("users").collect();
      const adminCount = teamMembers.filter(
        (u) => u.team_id?.toString() === requestingUser.team_id?.toString() && u.role === "admin"
      ).length;
      if (adminCount <= 1) {
        throw new Error("Cannot demote the last admin");
      }
    }
    await ctx.db.patch(args.member_user_id, { role: args.role });
  },
});

export const removeFromTeam = mutation({
  args: {
    team_id: v.id("teams"),
    user_id: v.id("users"),
    requesting_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    if (requestingUser.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    if (requestingUser.team_id?.toString() !== args.team_id.toString()) {
      throw new Error("Not a member of this team");
    }
    const userToRemove = await ctx.db.get(args.user_id);
    if (!userToRemove) {
      throw new Error("User not found");
    }
    if (userToRemove.team_id?.toString() !== args.team_id.toString()) {
      throw new Error("User not in this team");
    }
    if (args.requesting_user_id === args.user_id) {
      const teamMembers = await ctx.db.query("users").collect();
      const adminCount = teamMembers.filter(
        (u) => u.team_id?.toString() === args.team_id.toString() && u.role === "admin"
      ).length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    await ctx.db.patch(args.user_id, {
      team_id: undefined,
      role: undefined,
    });
  },
});

export const syncGithubOrg = action({
  args: {
    requesting_user_id: v.id("users"),
    org_name: v.string(),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.runQuery(api.users.getCurrentUser);
    if (!requestingUser || requestingUser._id !== args.requesting_user_id) {
      throw new Error("Not authenticated");
    }
    if (requestingUser.role !== "admin") {
      throw new Error("Only admins can sync GitHub organizations");
    }
    if (!requestingUser.team_id) {
      throw new Error("You must be part of a team to sync");
    }
    if (!requestingUser.github_access_token) {
      throw new Error("GitHub account not connected");
    }

    const membersResponse = await fetch(
      `https://api.github.com/orgs/${args.org_name}/members`,
      {
        headers: {
          Authorization: `Bearer ${requestingUser.github_access_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!membersResponse.ok) {
      const errorText = await membersResponse.text();
      throw new Error(`Failed to fetch GitHub org members: ${errorText}`);
    }

    const members = await membersResponse.json();
    const imported = [];
    const skipped = [];

    for (const member of members) {
      const membershipResponse = await fetch(
        `https://api.github.com/orgs/${args.org_name}/memberships/${member.login}`,
        {
          headers: {
            Authorization: `Bearer ${requestingUser.github_access_token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }
      );

      let role: "admin" | "member" = "member";
      if (membershipResponse.ok) {
        const membership = await membershipResponse.json();
        role = membership.role === "admin" ? "admin" : "member";
      }

      const existingUser = await ctx.runQuery(api.teams.getUserByGithubId, {
        github_id: String(member.id),
      });

      if (existingUser) {
        if (existingUser.team_id?.toString() === requestingUser.team_id.toString()) {
          skipped.push({
            github_username: member.login,
            reason: "Already a team member",
          });
          continue;
        }
        await ctx.runMutation(api.teams.updateUserTeamAndRole, {
          user_id: existingUser._id,
          team_id: requestingUser.team_id,
          role,
        });
        imported.push({
          github_username: member.login,
          name: existingUser.name,
          role,
        });
      } else {
        const newUserId = await ctx.runMutation(api.teams.createUserFromGithub, {
          github_id: String(member.id),
          github_username: member.login,
          github_avatar_url: member.avatar_url,
          team_id: requestingUser.team_id,
          role,
        });
        imported.push({
          github_username: member.login,
          name: member.login,
          role,
        });
      }
    }

    return {
      imported,
      skipped,
      total: members.length,
    };
  },
});

export const getUserByGithubId = query({
  args: {
    github_id: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_github_id", (q) => q.eq("github_id", args.github_id))
      .unique();
  },
});

export const updateUserTeamAndRole = mutation({
  args: {
    user_id: v.id("users"),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.user_id, {
      team_id: args.team_id,
      role: args.role,
    });
  },
});

export const createUserFromGithub = mutation({
  args: {
    github_id: v.string(),
    github_username: v.string(),
    github_avatar_url: v.string(),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      github_id: args.github_id,
      github_username: args.github_username,
      github_avatar_url: args.github_avatar_url,
      image: args.github_avatar_url,
      name: args.github_username,
      team_id: args.team_id,
      role: args.role,
      created_at: Date.now(),
    });
  },
});

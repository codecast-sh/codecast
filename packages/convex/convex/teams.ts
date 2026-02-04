import { mutation, query, action, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export const TEAM_ICONS = [
  "rocket", "flame", "zap", "star", "diamond", "crown",
  "shield", "sword", "anchor", "compass", "mountain", "tree",
  "sun", "moon", "cloud", "bolt", "atom", "dna",
  "hexagon", "triangle", "cube", "sphere", "infinity", "omega"
] as const;

export const TEAM_COLORS = [
  "cyan", "blue", "violet", "magenta", "green", "yellow", "orange"
] as const;

function getRandomIcon(): string {
  return TEAM_ICONS[Math.floor(Math.random() * TEAM_ICONS.length)];
}

function getRandomColor(): string {
  return TEAM_COLORS[Math.floor(Math.random() * TEAM_COLORS.length)];
}

export const getUserTeams = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    const teams = await Promise.all(
      memberships.map(async (m) => {
        const team = await ctx.db.get(m.team_id);
        if (!team) return null;
        return {
          _id: team._id,
          name: team.name,
          icon: team.icon,
          icon_color: team.icon_color,
          role: m.role,
          joined_at: m.joined_at,
          visibility: m.visibility || "summary",
        };
      })
    );
    return teams.filter(Boolean);
  },
});

export const getActiveTeamContext = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const team = await ctx.db.get(args.team_id);
    if (!team) {
      return null;
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership) {
      return null;
    }

    const memberCount = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();

    return {
      ...team,
      role: membership.role,
      memberCount: memberCount.length,
    };
  },
});

export const createTeam = mutation({
  args: {
    name: v.string(),
    user_id: v.id("users"),
    icon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const inviteCode = generateInviteCode();
    const now = Date.now();
    const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
    const teamId = await ctx.db.insert("teams", {
      name: args.name,
      icon: args.icon || getRandomIcon(),
      icon_color: getRandomColor(),
      created_at: now,
      invite_code: inviteCode,
      invite_code_expires_at: now + sevenDaysInMs,
    });
    await ctx.db.insert("team_memberships", {
      user_id: args.user_id,
      team_id: teamId,
      role: "admin",
      joined_at: now,
    });
    await ctx.db.patch(args.user_id, {
      team_id: teamId,
      role: "admin",
      active_team_id: teamId,
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
    const existingMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.user_id).eq("team_id", team._id))
      .unique();
    if (existingMembership) {
      return team._id;
    }
    const now = Date.now();
    await ctx.db.insert("team_memberships", {
      user_id: args.user_id,
      team_id: team._id,
      role: "member",
      joined_at: now,
    });
    const user = await ctx.db.get(args.user_id);
    if (!user?.team_id) {
      await ctx.db.patch(args.user_id, {
        team_id: team._id,
        role: "member",
        active_team_id: team._id,
      });
    }
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

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", team._id))
      .collect();

    const isExpired = !!(team.invite_code_expires_at && Date.now() > team.invite_code_expires_at);

    return {
      _id: team._id,
      name: team.name,
      memberCount: memberships.length,
      isExpired,
    };
  },
});

export const getTeamMembers = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();
    const members = await Promise.all(
      memberships.map(async (m) => {
        const user = await ctx.db.get(m.user_id);
        if (!user) return null;
        return {
          _id: user._id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: m.role,
          daemon_last_seen: user.daemon_last_seen,
          github_username: user.github_username,
          github_avatar_url: user.github_avatar_url,
          title: user.title,
          bio: user.bio,
          status: user.status,
          timezone: user.timezone,
        };
      })
    );
    return members.filter(Boolean);
  },
});

export const removeMember = mutation({
  args: {
    requesting_user_id: v.id("users"),
    member_user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    const teamId = args.team_id || requestingUser.team_id;
    if (!teamId) {
      throw new Error("No team specified");
    }
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.requesting_user_id).eq("team_id", teamId))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.member_user_id).eq("team_id", teamId))
      .unique();
    if (!memberMembership) {
      throw new Error("User is not a member of this team");
    }
    if (args.requesting_user_id === args.member_user_id) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    await ctx.db.delete(memberMembership._id);
    const memberUser = await ctx.db.get(args.member_user_id);
    if (memberUser?.team_id?.toString() === teamId.toString()) {
      const otherMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.member_user_id))
        .collect();
      if (otherMemberships.length > 0) {
        await ctx.db.patch(args.member_user_id, {
          team_id: otherMemberships[0].team_id,
          role: otherMemberships[0].role,
          active_team_id: otherMemberships[0].team_id,
        });
      } else {
        await ctx.db.patch(args.member_user_id, {
          team_id: undefined,
          role: undefined,
          active_team_id: undefined,
        });
      }
    }
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
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const requestingUser = await ctx.db.get(args.requesting_user_id);
    if (!requestingUser) {
      throw new Error("Requesting user not found");
    }
    const teamId = args.team_id || requestingUser.team_id;
    if (!teamId) {
      throw new Error("No team specified");
    }
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.requesting_user_id).eq("team_id", teamId))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can change member roles");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.member_user_id).eq("team_id", teamId))
      .unique();
    if (!memberMembership) {
      throw new Error("User not in this team");
    }
    if (args.role === "member" && memberMembership.role === "admin") {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot demote the last admin");
      }
    }
    await ctx.db.patch(memberMembership._id, { role: args.role });
    const memberUser = await ctx.db.get(args.member_user_id);
    if (memberUser?.team_id?.toString() === teamId.toString()) {
      await ctx.db.patch(args.member_user_id, { role: args.role });
    }
  },
});

export const removeFromTeam = mutation({
  args: {
    team_id: v.id("teams"),
    user_id: v.id("users"),
    requesting_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const requesterMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.requesting_user_id).eq("team_id", args.team_id))
      .unique();
    if (!requesterMembership || requesterMembership.role !== "admin") {
      throw new Error("Only admins can remove members");
    }
    const memberMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.user_id).eq("team_id", args.team_id))
      .unique();
    if (!memberMembership) {
      throw new Error("User not in this team");
    }
    if (args.requesting_user_id === args.user_id) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
        .collect();
      const adminCount = teamMemberships.filter(m => m.role === "admin").length;
      if (adminCount <= 1) {
        throw new Error("Cannot remove yourself as the last admin");
      }
    }
    await ctx.db.delete(memberMembership._id);
    const userToRemove = await ctx.db.get(args.user_id);
    if (userToRemove?.team_id?.toString() === args.team_id.toString()) {
      const otherMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
        .collect();
      if (otherMemberships.length > 0) {
        await ctx.db.patch(args.user_id, {
          team_id: otherMemberships[0].team_id,
          role: otherMemberships[0].role,
          active_team_id: otherMemberships[0].team_id,
        });
      } else {
        await ctx.db.patch(args.user_id, {
          team_id: undefined,
          role: undefined,
          active_team_id: undefined,
        });
      }
    }
  },
});

export const syncGithubOrg = action({
  args: {
    requesting_user_id: v.id("users"),
    org_name: v.string(),
  },
  handler: async (ctx, args): Promise<{
    imported: Array<{
      github_username: string;
      name: string;
      role: "admin" | "member";
    }>;
    skipped: Array<{
      github_username: string;
      reason: string;
    }>;
    total: number;
  }> => {
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
    const existingMembership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", args.user_id).eq("team_id", args.team_id))
      .unique();
    if (existingMembership) {
      await ctx.db.patch(existingMembership._id, { role: args.role });
    } else {
      await ctx.db.insert("team_memberships", {
        user_id: args.user_id,
        team_id: args.team_id,
        role: args.role,
        joined_at: Date.now(),
      });
    }
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
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      github_id: args.github_id,
      github_username: args.github_username,
      github_avatar_url: args.github_avatar_url,
      image: args.github_avatar_url,
      name: args.github_username,
      team_id: args.team_id,
      role: args.role,
      active_team_id: args.team_id,
      created_at: now,
    });
    await ctx.db.insert("team_memberships", {
      user_id: userId,
      team_id: args.team_id,
      role: args.role,
      joined_at: now,
    });
    return userId;
  },
});

export const migrateToMultiTeam = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let migratedCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      if (user.team_id) {
        const existingMembership = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q) => q.eq("user_id", user._id).eq("team_id", user.team_id!))
          .unique();

        if (!existingMembership) {
          await ctx.db.insert("team_memberships", {
            user_id: user._id,
            team_id: user.team_id,
            role: user.role || "member",
            joined_at: user.created_at || Date.now(),
          });
          migratedCount++;
        } else {
          skippedCount++;
        }

        if (!user.active_team_id) {
          await ctx.db.patch(user._id, { active_team_id: user.team_id });
        }

        if (user.team_share_paths && user.team_share_paths.length > 0) {
          for (const path of user.team_share_paths) {
            const existingMapping = await ctx.db
              .query("directory_team_mappings")
              .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
              .filter((q) => q.eq(q.field("path_prefix"), path))
              .first();

            if (!existingMapping) {
              await ctx.db.insert("directory_team_mappings", {
                user_id: user._id,
                path_prefix: path,
                team_id: user.team_id,
                auto_share: true,
                created_at: Date.now(),
              });
            }
          }
        }
      }
    }

    return { migratedCount, skippedCount };
  },
});

export const setActiveTeam = mutation({
  args: {
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    if (args.team_id) {
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id!))
        .unique();
      if (!membership) {
        throw new Error("Not a member of this team");
      }
      await ctx.db.patch(userId, {
        active_team_id: args.team_id,
        team_id: args.team_id,
        role: membership.role,
      });
    } else {
      await ctx.db.patch(userId, {
        active_team_id: undefined,
        team_id: undefined,
        role: undefined,
      });
    }
    return { success: true };
  },
});

export const setTeamVisibility = mutation({
  args: {
    team_id: v.id("teams"),
    visibility: v.union(
      v.literal("hidden"),
      v.literal("activity"),
      v.literal("summary"),
      v.literal("full")
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership) {
      throw new Error("Not a member of this team");
    }

    await ctx.db.patch(membership._id, { visibility: args.visibility });
    return { success: true };
  },
});

export const updateTeamIcon = mutation({
  args: {
    team_id: v.id("teams"),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id))
      .unique();

    if (!membership || membership.role !== "admin") {
      throw new Error("Only admins can change the team icon");
    }

    const updates: { icon?: string; icon_color?: string } = {};

    if (args.icon !== undefined) {
      if (!TEAM_ICONS.includes(args.icon as typeof TEAM_ICONS[number])) {
        throw new Error("Invalid icon");
      }
      updates.icon = args.icon;
    }

    if (args.icon_color !== undefined) {
      if (!TEAM_COLORS.includes(args.icon_color as typeof TEAM_COLORS[number])) {
        throw new Error("Invalid color");
      }
      updates.icon_color = args.icon_color;
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(args.team_id, updates);
    }

    return { success: true };
  },
});


import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    return await ctx.db.get(userId);
  },
});

export const createUser = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await ctx.db.insert("users", {
      email: args.email,
      name: args.name,
      created_at: Date.now(),
      role: "member",
    });
    return userId;
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    bio: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.optional(v.union(v.literal("available"), v.literal("busy"), v.literal("away"))),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const updateData: any = {};
    if (args.name !== undefined) updateData.name = args.name;
    if (args.bio !== undefined) updateData.bio = args.bio;
    if (args.title !== undefined) updateData.title = args.title;
    if (args.status !== undefined) updateData.status = args.status;
    if (args.timezone !== undefined) updateData.timezone = args.timezone;
    await ctx.db.patch(userId, updateData);
    return userId;
  },
});

export const setTheme = mutation({
  args: {
    theme: v.union(v.literal("dark"), v.literal("light")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    await ctx.db.patch(userId, {
      theme: args.theme,
    });
  },
});

export const updateDaemonLastSeen = mutation({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.user_id, {
      daemon_last_seen: Date.now(),
    });
  },
});

export const storePushToken = mutation({
  args: {
    push_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    await ctx.db.patch(userId, {
      push_token: args.push_token,
      notifications_enabled: true,
      notification_preferences: {
        team_session_start: true,
        mention: true,
        permission_request: true,
      },
    });
  },
});

export const updateNotificationPreferences = mutation({
  args: {
    notifications_enabled: v.optional(v.boolean()),
    notification_preferences: v.optional(v.object({
      team_session_start: v.boolean(),
      mention: v.boolean(),
      permission_request: v.boolean(),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const updateData: any = {};
    if (args.notifications_enabled !== undefined) {
      updateData.notifications_enabled = args.notifications_enabled;
    }
    if (args.notification_preferences !== undefined) {
      updateData.notification_preferences = args.notification_preferences;
    }
    await ctx.db.patch(userId, updateData);
  },
});

export const updatePrivacySettings = mutation({
  args: {
    hide_activity: v.optional(v.boolean()),
    encryption_enabled: v.optional(v.boolean()),
    encryption_master_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const updateData: any = {};
    if (args.hide_activity !== undefined) {
      updateData.hide_activity = args.hide_activity;
    }
    if (args.encryption_enabled !== undefined) {
      updateData.encryption_enabled = args.encryption_enabled;
    }
    if (args.encryption_master_key !== undefined) {
      updateData.encryption_master_key = args.encryption_master_key;
    }
    await ctx.db.patch(userId, updateData);
  },
});

export const getUserByUsername = query({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_github_username", (q) => q.eq("github_username", args.username))
      .unique();
    return user;
  },
});

export const getUserActivity = query({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) {
      return [];
    }
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) => q.eq(q.field("is_private"), false))
      .order("desc")
      .take(args.limit ?? 10);
    return conversations;
  },
});

export const getUserStats = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) {
      return null;
    }
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) => q.eq(q.field("is_private"), false))
      .collect();
    const totalMessages = conversations.reduce((sum, conv) => sum + conv.message_count, 0);
    return {
      total_conversations: conversations.length,
      total_messages: totalMessages,
      active_conversations: conversations.filter((c) => c.status === "active").length,
    };
  },
});

export const getTeamMembers = query({
  args: {
    team_id: v.id("teams"),
  },
  handler: async (ctx, args) => {
    const teamMembers = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("team_id"), args.team_id))
      .collect();

    return teamMembers.map((member) => ({
      _id: member._id,
      name: member.name,
      github_username: member.github_username,
      github_avatar_url: member.github_avatar_url,
    }));
  },
});

export const linkGitHub = mutation({
  args: {
    github_id: v.string(),
    github_username: v.string(),
    github_avatar_url: v.optional(v.string()),
    github_access_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_github_id", (q) => q.eq("github_id", args.github_id))
      .first();
    if (existingUser && existingUser._id !== userId) {
      throw new Error("This GitHub account is already linked to another user");
    }
    await ctx.db.patch(userId, {
      github_id: args.github_id,
      github_username: args.github_username,
      github_avatar_url: args.github_avatar_url,
      github_access_token: args.github_access_token,
    });
    return userId;
  },
});

export const unlinkGitHub = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.email) {
      throw new Error("Cannot unlink GitHub without an email/password login configured");
    }
    await ctx.db.patch(userId, {
      github_id: undefined,
      github_username: undefined,
      github_avatar_url: undefined,
      github_access_token: undefined,
    });
    return userId;
  },
});

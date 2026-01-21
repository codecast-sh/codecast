import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

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
    share_session_metadata: v.optional(v.boolean()),
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
    if (args.share_session_metadata !== undefined) {
      updateData.share_session_metadata = args.share_session_metadata;
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
    const limit = Math.min(args.limit ?? 3, 5);
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .order("desc")
      .take(limit);
    return conversations.map(c => ({
      _id: c._id,
      title: c.title,
      subtitle: c.subtitle,
      status: c.status,
      message_count: c.message_count,
      updated_at: c.updated_at,
      started_at: c.started_at,
      project_path: c.project_path,
    }));
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
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .order("desc")
      .take(10);
    const totalMessages = conversations.reduce((sum, conv) => sum + conv.message_count, 0);
    const activeCount = conversations.filter((c) => c.status === "active").length;
    return {
      total_conversations: conversations.length,
      total_messages: totalMessages,
      active_conversations: activeCount,
    };
  },
});

export const getUserAbstractActivity = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    if (!user) return null;

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const recentConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(10);

    const weekConversations = recentConversations.filter(c => c.started_at > oneWeekAgo);
    const monthConversations = recentConversations.filter(c => c.started_at > oneMonthAgo);
    const activeSession = recentConversations.find(c => c.status === "active");

    const projectCounts: Record<string, { sessions: number; messages: number; lastActive: number }> = {};
    monthConversations.forEach(c => {
      const project = c.project_path?.split('/').pop() || 'Unknown';
      if (!projectCounts[project]) {
        projectCounts[project] = { sessions: 0, messages: 0, lastActive: 0 };
      }
      projectCounts[project].sessions++;
      projectCounts[project].messages += c.message_count;
      projectCounts[project].lastActive = Math.max(projectCounts[project].lastActive, c.updated_at);
    });

    const recentProjects = Object.entries(projectCounts)
      .sort(([,a], [,b]) => b.lastActive - a.lastActive)
      .slice(0, 5)
      .map(([name, stats]) => ({
        name,
        sessions: stats.sessions,
        messages: stats.messages,
      }));

    const weekTotalMessages = weekConversations.reduce((sum, c) => sum + c.message_count, 0);
    const monthTotalMessages = monthConversations.reduce((sum, c) => sum + c.message_count, 0);

    let teamActivityStats = null;
    let recentCommits: Array<{ message: string; branch?: string; filesChanged?: number; timestamp: number }> = [];

    if (user.team_id) {
      const teamEvents = await ctx.db
        .query("team_activity_events")
        .withIndex("by_actor", (q) => q.eq("actor_user_id", args.user_id))
        .order("desc")
        .take(15);

      const weekEvents = teamEvents.filter(e => e.timestamp > oneWeekAgo);
      const monthEvents = teamEvents.filter(e => e.timestamp > oneMonthAgo);

      const weekCommits = weekEvents.filter(e => e.event_type === "commit_pushed").length;
      const monthCommits = monthEvents.filter(e => e.event_type === "commit_pushed").length;
      const weekPRs = weekEvents.filter(e => e.event_type === "pr_created" || e.event_type === "pr_merged").length;
      const monthPRs = monthEvents.filter(e => e.event_type === "pr_created" || e.event_type === "pr_merged").length;

      const weekFilesChanged = weekEvents
        .filter(e => e.event_type === "commit_pushed" && e.metadata?.files_changed)
        .reduce((sum, e) => sum + (e.metadata?.files_changed || 0), 0);

      const recentBranches = monthEvents
        .filter(e => e.metadata?.git_branch)
        .map(e => e.metadata!.git_branch!)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 5);

      recentCommits = monthEvents
        .filter(e => e.event_type === "commit_pushed")
        .slice(0, 5)
        .map(e => ({
          message: e.title,
          branch: e.metadata?.git_branch,
          filesChanged: e.metadata?.files_changed,
          timestamp: e.timestamp,
        }));

      teamActivityStats = {
        week_commits: weekCommits,
        month_commits: monthCommits,
        week_prs: weekPRs,
        month_prs: monthPRs,
        week_files_changed: weekFilesChanged,
        recent_branches: recentBranches,
      };
    }

    const hourOfDay: Record<number, number> = {};
    monthConversations.forEach(c => {
      const hour = new Date(c.started_at).getHours();
      hourOfDay[hour] = (hourOfDay[hour] || 0) + 1;
    });
    const peakHours = Object.entries(hourOfDay)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([hour]) => parseInt(hour));


    const daySet = new Set<string>();
    recentConversations.forEach(c => {
      const day = new Date(c.started_at).toISOString().split('T')[0];
      daySet.add(day);
    });
    const sortedDays = Array.from(daySet).sort().reverse();
    let streak = 0;
    for (let i = 0; i < sortedDays.length; i++) {
      const expectedDate = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      if (sortedDays[i] === expectedDate) {
        streak++;
      } else if (i === 0 && sortedDays[0] === new Date(Date.now() - 86400000).toISOString().split('T')[0]) {
        streak++;
      } else {
        break;
      }
    }

    const shareMetadata = user.share_session_metadata !== false;

    const recentSessions = shareMetadata ? weekConversations.slice(0, 5).map(c => ({
      title: c.title || 'Untitled Session',
      subtitle: c.subtitle,
      message_count: c.message_count,
      project: c.project_path?.split('/').pop(),
      started_at: c.started_at,
      updated_at: c.updated_at,
      status: c.status,
    })) : [];

    return {
      last_active: user.daemon_last_seen,
      is_currently_active: activeSession !== undefined,
      current_project: activeSession?.project_path?.split('/').pop(),
      week_sessions: weekConversations.length,
      month_sessions: monthConversations.length,
      week_messages: weekTotalMessages,
      month_messages: monthTotalMessages,
      activity_streak: streak,
      recent_projects: recentProjects,
      recent_sessions: recentSessions,
      recent_commits: recentCommits,
      peak_hours: peakHours,
      team_activity: teamActivityStats,
      share_session_metadata: shareMetadata,
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

export const updateSyncSettings = mutation({
  args: {
    sync_mode: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    sync_projects: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    const updateData: Record<string, unknown> = {};
    if (args.sync_mode !== undefined) {
      updateData.sync_mode = args.sync_mode;
    }
    if (args.sync_projects !== undefined) {
      updateData.sync_projects = args.sync_projects;
    }
    await ctx.db.patch(userId, updateData);
    return userId;
  },
});

export const getSyncSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }
    return {
      sync_mode: user.sync_mode ?? "all",
      sync_projects: user.sync_projects ?? [],
    };
  },
});

export const getSyncSettingsForCLI = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(result.userId);
    if (!user) {
      return { error: "User not found" };
    }
    return {
      sync_mode: user.sync_mode ?? "all",
      sync_projects: user.sync_projects ?? [],
    };
  },
});

export const updateSyncSettingsForCLI = mutation({
  args: {
    api_token: v.string(),
    sync_mode: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    sync_projects: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const updateData: Record<string, unknown> = {};
    if (args.sync_mode !== undefined) {
      updateData.sync_mode = args.sync_mode;
    }
    if (args.sync_projects !== undefined) {
      updateData.sync_projects = args.sync_projects;
    }
    await ctx.db.patch(result.userId, updateData);
    return { success: true };
  },
});

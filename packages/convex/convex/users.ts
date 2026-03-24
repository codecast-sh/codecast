import { mutation, query, internalMutation } from "./_generated/server";
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

export const updateUserActivity = internalMutation({
  args: {
    userId: v.id("users"),
    daemonSeen: v.optional(v.boolean()),
    messageTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.daemonSeen) {
      patch.daemon_last_seen = Date.now();
    }
    if (args.messageTimestamp) {
      const user = await ctx.db.get(args.userId);
      if (user && (!user.last_message_sent_at || args.messageTimestamp > user.last_message_sent_at)) {
        if (user.last_message_sent_at) {
          patch.prev_message_sent_at = user.last_message_sent_at;
          const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000;
          if (args.messageTimestamp - user.last_message_sent_at > GAP_THRESHOLD_MS) {
            patch.work_cluster_started_at = args.messageTimestamp;
          }
        }
        patch.last_message_sent_at = args.messageTimestamp;
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.userId, patch);
    }
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

export const daemonHeartbeat = mutation({
  args: {
    api_token: v.string(),
    version: v.string(),
    platform: v.string(),
    pid: v.number(),
    autostart_enabled: v.optional(v.boolean()),
    has_tmux: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) {
      return { error: "Unauthorized" };
    }

    const now = Date.now();
    await ctx.db.patch(auth.userId, {
      daemon_last_seen: now,
      last_heartbeat: now,
      cli_version: args.version,
      cli_platform: args.platform,
      daemon_pid: args.pid,
      autostart_enabled: args.autostart_enabled,
      has_tmux: args.has_tmux,
    });

    const allPendingCommands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) =>
        q.eq("user_id", auth.userId).eq("executed_at", undefined)
      )
      .collect();

    const COMMAND_TTL_MS = 5 * 60 * 1000;
    const pendingCommands = allPendingCommands.filter(
      (c) => now - c._creationTime < COMMAND_TTL_MS
    );
    for (const stale of allPendingCommands) {
      if (now - stale._creationTime >= COMMAND_TTL_MS) {
        await ctx.db.patch(stale._id, {
          executed_at: now,
          error: "expired_ttl",
        });
      }
    }

    const user = await ctx.db.get(auth.userId);

    const minVersionConfig = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "min_cli_version"))
      .unique();

    return {
      commands: pendingCommands.map((c) => ({
        id: c._id,
        command: c.command,
        args: c.args,
      })),
      sync_mode: user?.sync_mode ?? "all",
      sync_projects: user?.sync_projects ?? [],
      team_id: user?.active_team_id ?? user?.team_id ?? undefined,
      min_cli_version: minVersionConfig?.value ?? undefined,
      agent_permission_modes: user?.agent_permission_modes ?? undefined,
      agent_default_params: user?.agent_default_params ?? undefined,
    };
  },
});

export const reportCommandResult = mutation({
  args: {
    api_token: v.string(),
    command_id: v.id("daemon_commands"),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) {
      return { error: "Unauthorized" };
    }

    const command = await ctx.db.get(args.command_id);
    if (!command || command.user_id !== auth.userId) {
      return { error: "Command not found" };
    }

    await ctx.db.patch(args.command_id, {
      executed_at: Date.now(),
      result: args.result,
      error: args.error,
    });

    return { success: true };
  },
});

export const sendDaemonCommand = mutation({
  args: {
    user_id: v.id("users"),
    command: v.union(
      v.literal("status"),
      v.literal("restart"),
      v.literal("force_update"),
      v.literal("version"),
      v.literal("start_session"),
      v.literal("escape"),
      v.literal("resume_session")
    ),
    args_json: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.role !== "admin") {
      throw new Error("Not authorized");
    }

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: args.user_id,
      command: args.command,
      args: args.args_json,
      created_at: Date.now(),
    });

    return { command_id: commandId };
  },
});

export const resumeSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Not authenticated");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }
    if (!conversation.session_id) {
      throw new Error("No session ID on this conversation");
    }

    const agentType = conversation.agent_type === "codex" ? "codex" : conversation.agent_type === "gemini" ? "gemini" : "claude";

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: authUserId,
      command: "resume_session",
      args: JSON.stringify({
        session_id: conversation.session_id,
        agent_type: agentType,
        conversation_id: args.conversation_id,
        project_path: conversation.project_path || conversation.git_root,
      }),
      created_at: Date.now(),
    });

    return { command_id: commandId };
  },
});

export const getDaemonStatus = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return { users: [], isAdmin: false };
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.role !== "admin") {
      return { users: [], isAdmin: false };
    }

    const allUsers = await ctx.db.query("users").collect();
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000;

    const usersWithDaemon = allUsers
      .filter((u) => u.daemon_last_seen || u.last_heartbeat)
      .map((u) => ({
        _id: u._id,
        email: u.email,
        name: u.name,
        cli_version: u.cli_version,
        cli_platform: u.cli_platform,
        autostart_enabled: u.autostart_enabled,
        daemon_pid: u.daemon_pid,
        last_heartbeat: u.last_heartbeat,
        daemon_last_seen: u.daemon_last_seen,
        is_online: u.last_heartbeat ? now - u.last_heartbeat < tenMinutes : false,
        offline_duration: u.last_heartbeat ? now - u.last_heartbeat : null,
      }))
      .sort((a, b) => (b.last_heartbeat || 0) - (a.last_heartbeat || 0));

    return { users: usersWithDaemon, isAdmin: true };
  },
});

export const getPendingCommands = query({
  args: {
    user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.role !== "admin") {
      return [];
    }

    const query = args.user_id
      ? ctx.db
          .query("daemon_commands")
          .withIndex("by_user_pending", (q) => q.eq("user_id", args.user_id!))
      : ctx.db.query("daemon_commands");

    const commands = await query.order("desc").take(100);

    return commands;
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
        session_idle: true,
        session_error: true,
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
      session_idle: v.optional(v.boolean()),
      session_error: v.optional(v.boolean()),
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
    activity_visibility: v.optional(v.union(
      v.literal("detailed"),
      v.literal("summary"),
      v.literal("minimal"),
      v.literal("hidden")
    )),
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
    if (args.activity_visibility !== undefined) {
      updateData.activity_visibility = args.activity_visibility;
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

export const getDirectoryTeamMappings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    const mappingsWithTeams = await Promise.all(
      mappings.map(async (m) => {
        const team = await ctx.db.get(m.team_id);
        return {
          _id: m._id,
          path_prefix: m.path_prefix,
          team_id: m.team_id,
          team_name: team?.name ?? "Unknown Team",
          auto_share: m.auto_share,
          created_at: m.created_at,
        };
      })
    );
    return mappingsWithTeams;
  },
});

async function retroactivelyShareConversations(
  ctx: any,
  userId: any,
  pathPrefix: string,
  teamId: any,
) {
  const privateConvs = await ctx.db
    .query("conversations")
    .withIndex("by_user_private", (q: any) => q.eq("user_id", userId).eq("is_private", true))
    .take(500);

  let updated = 0;
  for (const conv of privateConvs) {
    const projectPath = conv.git_root || conv.project_path;
    if (projectPath && (projectPath === pathPrefix || projectPath.startsWith(pathPrefix + "/"))) {
      await ctx.db.patch(conv._id, { is_private: false, team_id: teamId });
      updated++;
    }
  }
  return updated;
}

export const backfillAutoShareConversations = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let mappings;
    if (args.userId) {
      mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", args.userId!))
        .collect();
    } else {
      mappings = await ctx.db.query("directory_team_mappings").take(50);
    }
    const autoShareMappings = mappings.filter(m => m.auto_share);
    let totalUpdated = 0;
    for (const mapping of autoShareMappings) {
      const count = await retroactivelyShareConversations(
        ctx, mapping.user_id, mapping.path_prefix, mapping.team_id
      );
      totalUpdated += count;
    }
    return { totalUpdated, mappingsProcessed: autoShareMappings.length };
  },
});

export const updateDirectoryTeamMapping = mutation({
  args: {
    path_prefix: v.string(),
    team_id: v.optional(v.id("teams")),
    auto_share: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const existingMapping = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .filter((q) => q.eq(q.field("path_prefix"), args.path_prefix))
      .first();

    if (!args.team_id) {
      if (existingMapping) {
        await ctx.db.delete(existingMapping._id);
      }
      return { success: true, deleted: true };
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", args.team_id!))
      .unique();
    if (!membership) {
      throw new Error("Not a member of this team");
    }

    const autoShare = args.auto_share ?? (existingMapping ? existingMapping.auto_share : true);

    if (existingMapping) {
      await ctx.db.patch(existingMapping._id, {
        team_id: args.team_id,
        auto_share: autoShare,
      });
    } else {
      await ctx.db.insert("directory_team_mappings", {
        user_id: userId,
        path_prefix: args.path_prefix,
        team_id: args.team_id,
        auto_share: autoShare,
        created_at: Date.now(),
      });
    }

    let retroactiveCount = 0;
    if (autoShare) {
      retroactiveCount = await retroactivelyShareConversations(ctx, userId, args.path_prefix, args.team_id);
    }

    return { success: true, updated: !!existingMapping, created: !existingMapping, retroactivelyShared: retroactiveCount };
  },
});

export const removeDirectoryTeamMapping = mutation({
  args: {
    path_prefix: v.string(),
    delete_conversations: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const mapping = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .filter((q) => q.eq(q.field("path_prefix"), args.path_prefix))
      .first();

    if (mapping) {
      await ctx.db.delete(mapping._id);
    }

    let conversationsDeleted = 0;
    let messagesDeleted = 0;
    if (args.delete_conversations) {
      const result = await deleteConversationsForPathInternal(ctx, userId, args.path_prefix);
      conversationsDeleted = result.conversationsDeleted;
      messagesDeleted = result.messagesDeleted;
    }

    return { success: true, conversationsDeleted, messagesDeleted };
  },
});

async function deleteConversationsForPathInternal(
  ctx: any,
  userId: any,
  pathPrefix: string,
) {
  const convos = await ctx.db
    .query("conversations")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .take(500);

  let conversationsDeleted = 0;
  let messagesDeleted = 0;
  for (const conv of convos) {
    const projectPath = conv.git_root || conv.project_path;
    if (projectPath && (projectPath === pathPrefix || projectPath.startsWith(pathPrefix + "/"))) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
        .take(1000);
      for (const msg of msgs) {
        await ctx.db.delete(msg._id);
        messagesDeleted++;
      }
      await ctx.db.delete(conv._id);
      conversationsDeleted++;
    }
  }
  return { conversationsDeleted, messagesDeleted };
}

export const countConversationsForPath = query({
  args: {
    path_prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { count: 0 };

    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(500);

    let count = 0;
    for (const conv of convos) {
      const projectPath = conv.git_root || conv.project_path;
      if (projectPath && (projectPath === args.path_prefix || projectPath.startsWith(args.path_prefix + "/"))) {
        count++;
      }
    }
    return { count };
  },
});

export const deleteConversationsForPath = mutation({
  args: {
    path_prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }
    return deleteConversationsForPathInternal(ctx, userId, args.path_prefix);
  },
});

export const getRecentProjectsWithGitInfo = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const limit = args.limit ?? 20;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(200);

    const projectMap = new Map<string, {
      git_root: string | null;
      project_path: string;
      session_count: number;
      last_active: number;
      git_remote_url?: string;
    }>();

    for (const conv of conversations) {
      const key = conv.git_root || conv.project_path;
      if (!key) continue;

      const existing = projectMap.get(key);
      if (existing) {
        existing.session_count++;
        existing.last_active = Math.max(existing.last_active, conv.updated_at);
      } else {
        projectMap.set(key, {
          git_root: conv.git_root || null,
          project_path: conv.project_path || key,
          session_count: 1,
          last_active: conv.updated_at,
          git_remote_url: conv.git_remote_url,
        });
      }
    }

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    const mappingsByPath = new Map(mappings.map(m => [m.path_prefix, m]));

    const projects = Array.from(projectMap.entries())
      .sort((a, b) => b[1].last_active - a[1].last_active)
      .slice(0, limit)
      .map(([path, data]) => {
        const mapping = mappingsByPath.get(path);
        return {
          path,
          is_git_repo: !!data.git_root,
          git_remote_url: data.git_remote_url,
          session_count: data.session_count,
          last_active: data.last_active,
          team_id: mapping?.team_id ?? null,
          auto_share: mapping?.auto_share ?? false,
        };
      });

    return projects;
  },
});

export const getRecentProjectPaths = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const limit = args.limit ?? 10;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(100);

    const pathCounts = new Map<string, { count: number; lastActive: number }>();
    for (const conv of conversations) {
      const path = conv.git_root || conv.project_path;
      if (!path) continue;
      const existing = pathCounts.get(path);
      if (existing) {
        existing.count++;
        existing.lastActive = Math.max(existing.lastActive, conv.updated_at);
      } else {
        pathCounts.set(path, { count: 1, lastActive: conv.updated_at });
      }
    }

    return Array.from(pathCounts.entries())
      .sort((a, b) => b[1].lastActive - a[1].lastActive)
      .slice(0, limit)
      .map(([path, stats]) => ({
        path,
        count: stats.count,
        lastActive: stats.lastActive,
      }));
  },
});

export const adminSetTeamMemberVisibility = internalMutation({
  args: {
    email: v.string(),
    visibility: v.union(
      v.literal("hidden"),
      v.literal("activity"),
      v.literal("summary"),
      v.literal("detailed"),
      v.literal("full")
    ),
    clearHideActivity: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) throw new Error("User not found");

    const updates: Record<string, unknown> = {
      activity_visibility: args.visibility,
    };
    if (args.clearHideActivity) {
      updates.hide_activity = false;
    }
    await ctx.db.patch(user._id, updates as any);
    return { success: true, user: user.name || user.email };
  },
});

export const deleteAccount = mutation({
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

    let totalDeleted = 0;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(50);

    for (const conv of conversations) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(500);
      for (const msg of messages) {
        await ctx.db.delete(msg._id);
        totalDeleted++;
      }

      const fileTouches = await ctx.db
        .query("file_touches")
        .withIndex("by_conversation", (q) => q.eq("conversation_id", conv._id))
        .take(200);
      for (const ft of fileTouches) {
        await ctx.db.delete(ft._id);
        totalDeleted++;
      }

      const comments = await ctx.db
        .query("comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(100);
      for (const comment of comments) {
        await ctx.db.delete(comment._id);
        totalDeleted++;
      }

      const publicComments = await ctx.db
        .query("public_comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(100);
      for (const pc of publicComments) {
        await ctx.db.delete(pc._id);
        totalDeleted++;
      }

      const pendingPermissions = await ctx.db
        .query("pending_permissions")
        .withIndex("by_conversation_status", (q) => q.eq("conversation_id", conv._id))
        .take(50);
      for (const pp of pendingPermissions) {
        await ctx.db.delete(pp._id);
        totalDeleted++;
      }

      await ctx.db.delete(conv._id);
      totalDeleted++;
    }

    const hasMoreConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();

    if (hasMoreConversations) {
      return {
        completed: false,
        message: "Partial deletion complete. Run again to continue deleting account data.",
        deleted: totalDeleted,
      };
    }

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(100);
    for (const b of bookmarks) {
      await ctx.db.delete(b._id);
      totalDeleted++;
    }

    const decisions = await ctx.db
      .query("decisions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(100);
    for (const d of decisions) {
      await ctx.db.delete(d._id);
      totalDeleted++;
    }

    const patterns = await ctx.db
      .query("patterns")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(100);
    for (const p of patterns) {
      await ctx.db.delete(p._id);
      totalDeleted++;
    }

    const syncCursors = await ctx.db
      .query("sync_cursors")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(100);
    for (const sc of syncCursors) {
      await ctx.db.delete(sc._id);
      totalDeleted++;
    }

    const rateLimits = await ctx.db
      .query("rate_limits")
      .withIndex("by_user_endpoint", (q) => q.eq("user_id", userId))
      .take(100);
    for (const rl of rateLimits) {
      await ctx.db.delete(rl._id);
      totalDeleted++;
    }

    const apiTokens = await ctx.db
      .query("api_tokens")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(50);
    for (const at of apiTokens) {
      await ctx.db.delete(at._id);
      totalDeleted++;
    }

    const pendingMessages = await ctx.db
      .query("pending_messages")
      .withIndex("by_user_status", (q) => q.eq("from_user_id", userId))
      .take(100);
    for (const pm of pendingMessages) {
      await ctx.db.delete(pm._id);
      totalDeleted++;
    }

    const managedSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(50);
    for (const ms of managedSessions) {
      await ctx.db.delete(ms._id);
      totalDeleted++;
    }

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_recipient", (q) => q.eq("recipient_user_id", userId))
      .take(200);
    for (const n of notifications) {
      await ctx.db.delete(n._id);
      totalDeleted++;
    }

    const daemonLogs = await ctx.db
      .query("daemon_logs")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .take(500);
    for (const dl of daemonLogs) {
      await ctx.db.delete(dl._id);
      totalDeleted++;
    }

    const messageShares = await ctx.db
      .query("message_shares")
      .filter((q) => q.eq(q.field("user_id"), userId))
      .take(100);
    for (const ms of messageShares) {
      await ctx.db.delete(ms._id);
      totalDeleted++;
    }

    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewer", (q) => q.eq("reviewer_user_id", userId))
      .take(100);
    for (const r of reviews) {
      await ctx.db.delete(r._id);
      totalDeleted++;
    }

    const teamActivityEvents = await ctx.db
      .query("team_activity_events")
      .withIndex("by_actor", (q) => q.eq("actor_user_id", userId))
      .take(200);
    for (const tae of teamActivityEvents) {
      await ctx.db.delete(tae._id);
      totalDeleted++;
    }

    // @ts-ignore - authAccounts is from @convex-dev/auth
    const authAccounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q: any) => q.eq("userId", userId))
      .take(10);
    for (const aa of authAccounts) {
      await ctx.db.delete(aa._id);
      totalDeleted++;
    }

    // @ts-ignore - authSessions is from @convex-dev/auth
    const authSessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q: any) => q.eq("userId", userId))
      .take(50);
    for (const as of authSessions) {
      await ctx.db.delete(as._id);
      totalDeleted++;
    }

    await ctx.db.delete(userId);
    totalDeleted++;

    return {
      completed: true,
      message: "Account permanently deleted",
      deleted: totalDeleted,
    };
  },
});

export const getMyPendingCommands = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) {
      return [];
    }

    const COMMAND_TTL_MS = 5 * 60 * 1000;
    const now = Date.now();
    const commands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) =>
        q.eq("user_id", auth.userId).eq("executed_at", undefined)
      )
      .collect();

    return commands
      .filter((c) => now - c._creationTime < COMMAND_TTL_MS)
      .map((c) => ({
        id: c._id,
        command: c.command,
        args: c.args,
      }));
  },
});

export const startSession = mutation({
  args: {
    agent_type: v.union(
      v.literal("claude"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini")
    ),
    project_path: v.optional(v.string()),
    prompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const now = Date.now();
    const sessionId = `remote-${crypto.randomUUID()}`;

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: args.agent_type === "claude" ? "claude_code" : args.agent_type,
      session_id: sessionId,
      project_path: args.project_path,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: true,
      status: "active" as const,
    });

    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: "start_session",
      args: JSON.stringify({
        agent_type: args.agent_type,
        project_path: args.project_path,
        prompt: args.prompt,
        conversation_id: conversationId,
        session_id: sessionId,
      }),
      created_at: now,
    });

    return { command_id: commandId, conversation_id: conversationId };
  },
});

export const getTeamsForCLI = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
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
          visibility: m.visibility || "summary",
        };
      })
    );
    return { teams: teams.filter(Boolean) };
  },
});

export const getDirectoryMappingsForCLI = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .collect();

    const mappingsWithTeams = await Promise.all(
      mappings.map(async (m) => {
        const team = await ctx.db.get(m.team_id);
        return {
          path_prefix: m.path_prefix,
          team_id: m.team_id,
          team_name: team?.name ?? "Unknown",
          auto_share: m.auto_share,
        };
      })
    );
    return { mappings: mappingsWithTeams };
  },
});

export const updateDirectoryMappingForCLI = mutation({
  args: {
    api_token: v.string(),
    path_prefix: v.string(),
    team_id: v.optional(v.string()),
    auto_share: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const existingMapping = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .filter((q) => q.eq(q.field("path_prefix"), args.path_prefix))
      .first();

    if (!args.team_id) {
      if (existingMapping) {
        await ctx.db.delete(existingMapping._id);
      }
      return { success: true, action: "removed" };
    }

    const teamId = args.team_id as any;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", result.userId).eq("team_id", teamId))
      .unique();
    if (!membership) {
      return { error: "Not a member of this team" };
    }

    const autoShare = args.auto_share ?? (existingMapping ? existingMapping.auto_share : true);

    if (existingMapping) {
      await ctx.db.patch(existingMapping._id, {
        team_id: teamId,
        auto_share: autoShare,
      });
    } else {
      await ctx.db.insert("directory_team_mappings", {
        user_id: result.userId,
        path_prefix: args.path_prefix,
        team_id: teamId,
        auto_share: autoShare,
        created_at: Date.now(),
      });
    }

    let retroactiveCount = 0;
    if (autoShare) {
      retroactiveCount = await retroactivelyShareConversations(ctx, result.userId, args.path_prefix, teamId);
    }

    return { success: true, action: existingMapping ? "updated" : "created", retroactivelyShared: retroactiveCount };
  },
});

export const countConversationsForPathCLI = query({
  args: {
    api_token: v.string(),
    path_prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .take(500);

    let count = 0;
    for (const conv of convos) {
      const projectPath = conv.git_root || conv.project_path;
      if (projectPath && (projectPath === args.path_prefix || projectPath.startsWith(args.path_prefix + "/"))) {
        count++;
      }
    }
    return { count };
  },
});

export const deleteConversationsForPathCLI = mutation({
  args: {
    api_token: v.string(),
    path_prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    return deleteConversationsForPathInternal(ctx, result.userId, args.path_prefix);
  },
});

export const getProjectsWithTeamsForCLI = query({
  args: {
    api_token: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }
    const limit = args.limit ?? 30;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .order("desc")
      .take(200);

    const projectMap = new Map<string, {
      session_count: number;
      last_active: number;
    }>();

    for (const conv of conversations) {
      const key = conv.git_root || conv.project_path;
      if (!key) continue;

      const existing = projectMap.get(key);
      if (existing) {
        existing.session_count++;
        existing.last_active = Math.max(existing.last_active, conv.updated_at);
      } else {
        projectMap.set(key, {
          session_count: 1,
          last_active: conv.updated_at,
        });
      }
    }

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .collect();

    const mappingsWithTeams = await Promise.all(
      mappings.map(async (m) => {
        const team = await ctx.db.get(m.team_id);
        return {
          path_prefix: m.path_prefix,
          team_id: m.team_id,
          team_name: team?.name ?? "Unknown",
        };
      })
    );
    const mappingsByPath = new Map(mappingsWithTeams.map(m => [m.path_prefix, m]));

    for (const m of mappingsWithTeams) {
      if (!projectMap.has(m.path_prefix)) {
        projectMap.set(m.path_prefix, {
          session_count: 0,
          last_active: 0,
        });
      }
    }

    const projects = Array.from(projectMap.entries())
      .sort((a, b) => b[1].last_active - a[1].last_active)
      .slice(0, limit)
      .map(([path, data]) => {
        const mapping = mappingsByPath.get(path);
        return {
          path,
          session_count: data.session_count,
          last_active: data.last_active,
          team_id: mapping?.team_id ?? null,
          team_name: mapping?.team_name ?? null,
        };
      });

    return { projects };
  },
});

export const getAgentPermissionModes = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user?.agent_permission_modes ?? null;
  },
});

export const updateAgentPermissionModes = mutation({
  args: {
    claude: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
    codex: v.optional(v.union(v.literal("default"), v.literal("full_auto"), v.literal("bypass"))),
    gemini: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await ctx.db.patch(userId, {
      agent_permission_modes: {
        claude: args.claude,
        codex: args.codex,
        gemini: args.gemini,
      },
    });
    return userId;
  },
});

export const getAgentDefaultParams = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user?.agent_default_params ?? null;
  },
});

export const updateAgentDefaultParams = mutation({
  args: {
    api_token: v.optional(v.string()),
    agent: v.union(v.literal("claude"), v.literal("codex"), v.literal("gemini"), v.literal("cursor")),
    params: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    let userId;
    if (args.api_token) {
      const auth = await verifyApiToken(ctx, args.api_token, false);
      if (!auth) throw new Error("Unauthorized");
      userId = auth.userId;
    } else {
      userId = await getAuthUserId(ctx);
      if (!userId) throw new Error("Not authenticated");
    }
    const user = await ctx.db.get(userId);
    const existing = user?.agent_default_params ?? {};
    await ctx.db.patch(userId, {
      agent_default_params: {
        ...existing,
        [args.agent]: args.params,
      },
    });
    return userId;
  },
});

export const deleteAgentDefaultParam = mutation({
  args: {
    agent: v.union(v.literal("claude"), v.literal("codex"), v.literal("gemini"), v.literal("cursor")),
    param: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    const existing = user?.agent_default_params ?? {};
    const agentParams = { ...(existing[args.agent] ?? {}) };
    delete agentParams[args.param];
    await ctx.db.patch(userId, {
      agent_default_params: {
        ...existing,
        [args.agent]: agentParams,
      },
    });
    return userId;
  },
});

export const sendConfigCommand = mutation({
  args: {
    command: v.union(
      v.literal("config_list"),
      v.literal("config_read"),
      v.literal("config_write"),
      v.literal("config_create"),
      v.literal("config_delete")
    ),
    args_json: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: userId,
      command: args.command,
      args: args.args_json,
      created_at: Date.now(),
    });
    return { command_id: commandId };
  },
});

export const getCommandResult = query({
  args: {
    command_id: v.id("daemon_commands"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const cmd = await ctx.db.get(args.command_id);
    if (!cmd || cmd.user_id !== userId) return null;
    return {
      executed_at: cmd.executed_at,
      result: cmd.result,
      error: cmd.error,
    };
  },
});



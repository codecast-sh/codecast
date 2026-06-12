import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { PaginationOptions, PaginationResult, RegisteredQuery } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { enqueueStartSession, getOnlineLocalRoots } from "./devices";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { hasRecentPendingDaemonCommand } from "./daemonCommandUtils";
import { resolveTeamForPath, getProfileVisibilityPredicate, profilePublicSessionVisible } from "./privacy";
import { resetConversationPendingMessages } from "./pendingMessages";
import { normalizeProjectPath } from "./projectPaths";

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

// Identical payload to getCurrentUser, but a distinct function nothing
// subscribes to via useQuery. The web recovery poll uses this so its one-shot
// gets a unique query token: ConvexReactClient.query() returns the cached value
// of any live subscription sharing the token, so probing getCurrentUser itself
// would just re-read the stalled cache it's trying to refresh. With no live
// subscriber here the token is never cached and the probe always round-trips —
// the safety net that keeps the daemon-stale banner from sticking until reload.
// `_probe` (ignored) varies per call as extra insurance against future callers.
export const getCurrentUserProbe = query({
  args: { _probe: v.optional(v.number()) },
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
    const user = await ctx.db.get(args.userId);
    if (!user) return;
    if (args.daemonSeen) {
      // Throttle: this fires on every message sync across all of the user's
      // sessions, contending on a single hot doc. Only refresh when stale.
      const DAEMON_SEEN_THROTTLE_MS = 60 * 1000;
      if (!user.daemon_last_seen || Date.now() - user.daemon_last_seen > DAEMON_SEEN_THROTTLE_MS) {
        patch.daemon_last_seen = Date.now();
      }
    }
    if (args.messageTimestamp) {
      if (!user.last_message_sent_at || args.messageTimestamp > user.last_message_sent_at) {
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
    local_project_roots: v.optional(v.array(v.string())),
    pending_sync_count: v.optional(v.number()),
    oldest_pending_ms: v.optional(v.number()),
    // Device identity (remote/device.ts). When present, upsert a per-device
    // row so multiple machines don't clobber each other's project roots.
    device_id: v.optional(v.string()),
    device_label: v.optional(v.string()),
    is_remote_device: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // updateLastUsed=true here is the ONLY token-doc refresh: heartbeat is a
    // single call per 30s, so its throttled last_used_at write can't create the
    // cross-session OCC contention that the per-message write path did.
    const auth = await verifyApiToken(ctx, args.api_token, true);
    if (!auth) {
      return { error: "Unauthorized" };
    }

    const now = Date.now();
    // Coalesce the user-doc write. This doc is HOT: webListPaginated and the
    // daemon-health queries read it, so an unconditional patch every 30s beat
    // (× the whole fleet) invalidated those subscriptions ~per-second and drove
    // the OCC contention / 1011 WS storm. Mirror updateUserActivity: read first,
    // patch only what changed, and refresh the volatile liveness/queue fields on
    // a throttle (the readers only need minute-granularity online detection).
    const HEARTBEAT_WRITE_THROTTLE_MS = 50 * 1000;
    const existingUser = await ctx.db.get(auth.userId);
    const newPending = args.pending_sync_count ?? 0;
    const newOldest = args.oldest_pending_ms ?? 0;

    const patch: Record<string, any> = {};
    // Sticky fields: write only on actual change.
    if (existingUser?.cli_version !== args.version) patch.cli_version = args.version;
    if (existingUser?.cli_platform !== args.platform) patch.cli_platform = args.platform;
    if (existingUser?.daemon_pid !== args.pid) patch.daemon_pid = args.pid;
    if (existingUser?.autostart_enabled !== args.autostart_enabled) patch.autostart_enabled = args.autostart_enabled;
    if (existingUser?.has_tmux !== args.has_tmux) patch.has_tmux = args.has_tmux;

    // Volatile liveness/queue fields: refresh on a throttle, when queue zeroness
    // flips (so a newly-stuck queue still surfaces promptly), or when we're already
    // writing a sticky change anyway.
    const lastSeenStale =
      !existingUser?.daemon_last_seen || now - existingUser.daemon_last_seen > HEARTBEAT_WRITE_THROTTLE_MS;
    const queueZeronessFlipped =
      ((existingUser?.daemon_pending_sync_count ?? 0) === 0) !== (newPending === 0);
    if (lastSeenStale || queueZeronessFlipped || Object.keys(patch).length > 0) {
      patch.daemon_last_seen = now;
      patch.last_heartbeat = now;
      patch.daemon_pending_sync_count = newPending;
      patch.daemon_oldest_pending_ms = newOldest;
    }

    if (args.local_project_roots !== undefined) {
      // NOTE: every daemon overwrites this per-user field, so for multi-machine
      // users it flip-flops between machines on each heartbeat. Read paths now use
      // the per-device union (getOnlineLocalRoots) instead; this write is retained
      // only for rollback safety and can be dropped once nothing depends on it.
      // Write only when the set actually changed — an unconditional rewrite is a
      // needless invalidation of every user-doc reader.
      const prev = existingUser?.local_project_roots;
      const next = args.local_project_roots;
      const rootsChanged =
        !prev || prev.length !== next.length || prev.some((p: string, i: number) => p !== next[i]);
      if (rootsChanged) {
        patch.local_project_roots = next;
        patch.local_project_roots_updated_at = now;
      }
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(auth.userId, patch);
    }

    // Per-device row upsert (multi-machine): the stable, non-clobbered source the
    // read paths consume via getOnlineLocalRoots (union across online devices).
    if (args.device_id) {
      const existingDevice = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q) =>
          q.eq("user_id", auth.userId).eq("device_id", args.device_id!),
        )
        .first();
      const devicePatch = {
        label: args.device_label ?? args.platform,
        platform: args.platform,
        last_seen: now,
        status: "online" as const,
        ...(args.is_remote_device !== undefined ? { is_remote: args.is_remote_device } : {}),
        ...(args.local_project_roots !== undefined
          ? { local_project_roots: args.local_project_roots }
          : {}),
      };
      if (existingDevice) {
        await ctx.db.patch(existingDevice._id, devicePatch);
      } else {
        await ctx.db.insert("devices", {
          user_id: auth.userId,
          device_id: args.device_id,
          ...devicePatch,
        });
      }
    }

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

    // Device routing: a command with a target_device_id is delivered ONLY to that
    // daemon. This is what stops every daemon from racing a session command —
    // start_session/resume go to the one machine that owns the checkout. Untargeted
    // commands (status/restart, or sessions with no resolvable owner) broadcast to
    // all daemons. Rollout-safe: a daemon that doesn't identify itself (pre-routing
    // CLI) sees everything, so new sessions still start before the fleet upgrades.
    const visibleCommands =
      args.device_id === undefined
        ? pendingCommands
        : pendingCommands.filter(
            (c) => c.target_device_id === undefined || c.target_device_id === args.device_id,
          );

    // Reuse the doc read above for the return payload — these fields are sticky
    // (untouched by the heartbeat patch), so the pre-patch snapshot is correct and
    // we avoid a second read of the hot user doc.
    const user = existingUser;

    const minVersionConfig = await ctx.db
      .query("system_config")
      .withIndex("by_key", (q) => q.eq("key", "min_cli_version"))
      .unique();

    return {
      commands: visibleCommands.map((c) => ({
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
      v.literal("reinstall"),
      v.literal("version"),
      v.literal("start_session"),
      v.literal("escape"),
      v.literal("resume_session"),
      v.literal("kill_session"),
      v.literal("send_keys"),
      v.literal("rewind"),
      v.literal("config_list"),
      v.literal("config_read"),
      v.literal("config_write"),
      v.literal("config_create"),
      v.literal("config_delete"),
      v.literal("run_workflow")
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

export const sendDaemonCommandToAll = mutation({
  args: {
    command: v.union(
      v.literal("restart"),
      v.literal("force_update"),
      v.literal("reinstall")
    ),
    max_version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Not authenticated");
    const currentUser = await ctx.db.get(authUserId);
    if (!currentUser || currentUser.role !== "admin") throw new Error("Not authorized");

    const allUsers = await ctx.db.query("users").collect();
    const now = Date.now();
    const recentlyActive = allUsers.filter(
      (u) => u.last_heartbeat && now - u.last_heartbeat < 24 * 60 * 60 * 1000
    );

    let targeted = recentlyActive;
    if (args.max_version) {
      targeted = recentlyActive.filter((u) => {
        if (!u.cli_version) return true;
        const parts = u.cli_version.split(".").map(Number);
        const maxParts = args.max_version!.split(".").map(Number);
        for (let i = 0; i < Math.max(parts.length, maxParts.length); i++) {
          if ((parts[i] || 0) < (maxParts[i] || 0)) return true;
          if ((parts[i] || 0) > (maxParts[i] || 0)) return false;
        }
        return false;
      });
    }

    let sent = 0;
    for (const user of targeted) {
      await ctx.db.insert("daemon_commands", {
        user_id: user._id,
        command: args.command,
        created_at: now,
      });
      sent++;
    }

    return { sent, total: recentlyActive.length };
  },
});

// Admin-only internal mutation for CLI use with admin key
export const internalSendCommand = internalMutation({
  args: {
    email: v.string(),
    command: v.string(),
    args_json: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find(u => u.email === args.email);
    if (!user) throw new Error(`User not found: ${args.email}`);

    const commandId = await ctx.db.insert("daemon_commands", {
      user_id: user._id,
      command: args.command as any,
      args: args.args_json,
      created_at: Date.now(),
    });
    return { command_id: commandId, user_id: user._id };
  },
});

export const internalExpireCommands = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find(u => u.email === args.email);
    if (!user) throw new Error(`User not found: ${args.email}`);
    const pending = await ctx.db.query("daemon_commands")
      .withIndex("by_user_pending", q => q.eq("user_id", user._id).eq("executed_at", undefined))
      .collect();
    for (const cmd of pending) {
      await ctx.db.patch(cmd._id, { executed_at: Date.now(), error: "expired_manual" });
    }
    return { expired: pending.length, commands: pending.map(c => c.command) };
  },
});

export const internalGetCommand = internalMutation({
  args: { command_id: v.id("daemon_commands") },
  handler: async (ctx, args) => {
    const cmd = await ctx.db.get(args.command_id);
    return cmd ? { command: cmd.command, result: cmd.result, error: cmd.error, executed_at: cmd.executed_at } : null;
  },
});

export const internalListUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter(u => u.last_heartbeat)
      .map(u => ({ email: u.email, _id: u._id, cli_version: u.cli_version, last_heartbeat: u.last_heartbeat }))
      .sort((a, b) => (b.last_heartbeat ?? 0) - (a.last_heartbeat ?? 0));
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

    // Skip resume for fresh 0-message sessions. The inline new-session flow
    // (DashboardLayout.handleQuickCreate, ContextChatInput.handleSubmit)
    // stamps a 10-char nanoid as session_id before any Claude process exists,
    // so a `claude --resume <nanoid>` would fail every time. The UI's
    // stuck-banner auto-resume kept firing this for brand-new sessions,
    // triggering kill → repair → reconstitute → start-fresh churn on the
    // daemon. tryStartedTmux on the daemon side already delivers the first
    // message via the pane, so a no-op here is safe.
    if ((conversation.message_count ?? 0) === 0) {
      return { skipped: true, reason: "fresh_session_no_messages" } as const;
    }

    const agentType = conversation.agent_type === "codex" ? "codex" : conversation.agent_type === "gemini" ? "gemini" : "claude";
    const pendingCommands = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) => q.eq("user_id", authUserId).eq("executed_at", undefined))
      .collect();

    // Re-queue any stranded messages so the resume actually delivers them. A message that
    // failed to reach a dead session sits as injected/failed/undeliverable; without this it
    // stays stuck and the user has to manually resend. restartSession already does this — the
    // missing call here was the asymmetry that left "Force resume" doing nothing visible.
    if (hasRecentPendingDaemonCommand(pendingCommands as any, {
      conversationId: args.conversation_id.toString(),
      command: "resume_session",
    })) {
      await resetConversationPendingMessages(ctx, args.conversation_id);
      return { deduplicated: true };
    }

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

    await resetConversationPendingMessages(ctx, args.conversation_id);
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
      task_activity: v.optional(v.boolean()),
      doc_activity: v.optional(v.boolean()),
      plan_activity: v.optional(v.boolean()),
    })),
    muted_members: v.optional(v.array(v.id("users"))),
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
    if (args.muted_members !== undefined) {
      updateData.muted_members = args.muted_members;
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
    username: v.optional(v.string()),
    user_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    if (args.user_id) {
      return ctx.db.get(args.user_id);
    }
    if (args.username) {
      const byUsername = await ctx.db
        .query("users")
        .withIndex("by_github_username", (q) => q.eq("github_username", args.username))
        .first();
      if (byUsername) return byUsername;
      const asId = ctx.db.normalizeId("users", args.username);
      if (asId) return ctx.db.get(asId);
      const lower = args.username.toLowerCase();
      const all = await ctx.db.query("users").take(200);
      return all.find((u) =>
        u.name?.toLowerCase() === lower ||
        u.github_username?.toLowerCase() === lower
      ) || null;
    }
    return null;
  },
});

export const getUserActivity = query({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.user_id);
    // Public, unauthed query. is_private=false means TEAM-visible, not world-
    // visible, so it must stay gated behind the explicit public-profile opt-in.
    if (!user || user.hide_activity || !user.public_profile_enabled) {
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
    if (!user || user.hide_activity || !user.public_profile_enabled) {
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

// ── Public profiles ──────────────────────────────────────────────────────────
// Anonymous, opt-in profile pages at /u/<username>. Three rules govern them:
//   1. Nothing is anonymously readable until public_profile_enabled is true.
//   2. The handle is a claimed, unique `username` (github_username only pre-fills).
//   3. Sessions appear only because they were explicitly pinned (profile_pinned_at),
//      which guarantees a share_token — so cards deep-link to the /share viewer.
// Counts/heatmap are anonymized aggregates (no titles/ids cross the boundary).

// Handles live at the ROOT (/<handle>), sharing the URL namespace with every
// top-level route. React Router still serves real routes (static beats dynamic),
// but a handle matching one would be an unreachable, confusing profile — so block
// them. KEEP IN SYNC with the top-level <Route> paths in web/src/App.tsx; add any
// new first-segment route here. Plus product nouns we don't want impersonated.
const RESERVED_USERNAMES = new Set([
  // Top-level route segments (web/src/App.tsx)
  "about", "features", "documentation", "privacy", "security", "support", "terms",
  "login", "signup", "signin", "logout", "forgot-password", "reset-password", "auth",
  "join", "inbox", "feed", "search", "notifications", "conversation", "docs", "plans",
  "tasks", "projects", "workflows", "routines", "schedules", "sessions", "team",
  "admin", "config", "dashboard", "explore", "timeline", "windows", "orchestration",
  "roadmap", "cli", "share", "commit", "pr", "review", "palette", "settings",
  // Product nouns / safety
  "u", "api", "teams", "codecast", "help", "status", "me", "you", "new", "null", "undefined",
]);

// Lowercase, 3–30 chars, alnum + single internal dashes, must start/end alnum.
// Returns the normalized handle or an error string.
export function normalizeUsername(raw: string): { username?: string; error?: string } {
  const username = raw.trim().toLowerCase();
  if (username.length < 3) return { error: "Username must be at least 3 characters" };
  if (username.length > 30) return { error: "Username must be at most 30 characters" };
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(username))
    return { error: "Use lowercase letters, numbers, and single dashes (no leading/trailing dash)" };
  if (RESERVED_USERNAMES.has(username)) return { error: "That username is reserved" };
  return { username };
}

// Last path segment only — the public profile shows "codecast", never the
// owner's full "/Users/ashot/src/codecast" home-dir layout.
function basenameOf(path?: string): string | null {
  if (!path) return null;
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}

// Whitelisted, never-leaks-internal-fields view of a user for anonymous pages.
function publicUserCard(user: any) {
  return {
    _id: user._id,
    username: user.username,
    name: user.name,
    avatar_url: user.github_avatar_url ?? user.image ?? null,
    github_username: user.github_username ?? null,
    bio: user.bio ?? null,
    title: user.title ?? null,
    timezone: user.timezone ?? null,
  };
}

// Is the requested handle available for this user to claim?
export const isUsernameAvailable = query({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const { username, error } = normalizeUsername(args.username);
    if (error) return { available: false, reason: error };
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    const me = await getAuthUserId(ctx);
    if (existing && (!me || existing._id.toString() !== me.toString())) {
      return { available: false, reason: "That username is taken" };
    }
    return { available: true, username };
  },
});

// Claim (or change) the caller's public handle. Uniqueness-checked.
export const claimUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const me = await getAuthUserId(ctx);
    if (!me) throw new Error("Unauthorized");
    const { username, error } = normalizeUsername(args.username);
    if (error) throw new Error(error);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (existing && existing._id.toString() !== me.toString()) {
      throw new Error("That username is taken");
    }
    await ctx.db.patch(me, { username });
    return { username };
  },
});

// The master opt-in switch. Refuses to enable without a claimed handle, since
// the public URL is the handle — there'd be nothing to route to.
export const setPublicProfileEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const me = await getAuthUserId(ctx);
    if (!me) throw new Error("Unauthorized");
    if (args.enabled) {
      const user = await ctx.db.get(me);
      if (!user?.username) throw new Error("Claim a username before enabling your public profile");
    }
    await ctx.db.patch(me, { public_profile_enabled: args.enabled });
    return { enabled: args.enabled };
  },
});

// PUBLIC. The 404 gate lives here: returns null unless the handle resolves AND
// the owner has the profile switched on. Only whitelisted fields ever escape.
export const getPublicProfile = query({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const handle = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", handle))
      .first();
    if (!user || !user.public_profile_enabled) return null;

    // Aggregate, anonymized stats from the public (pinned) tier only.
    const pinned = await ctx.db
      .query("conversations")
      .withIndex("by_user_profile_pinned", (q) =>
        q.eq("user_id", user._id).gt("profile_pinned_at", 0)
      )
      .collect();
    const publicPins = pinned.filter((c) => profilePublicSessionVisible(c));

    return {
      ...publicUserCard(user),
      show_activity_graph: !user.hide_activity,
      stats: {
        pinned_sessions: publicPins.length,
        pinned_messages: publicPins.reduce((s, c) => s + (c.message_count ?? 0), 0),
      },
    };
  },
});

// PUBLIC. The pinned sessions, newest pin first. Defense-in-depth filtered to
// those still backed by a share_token; each row carries that token so the card
// links straight to the existing guest /share viewer. Never leaks the full
// local path — only the repo/folder basename.
export const getPublicPinnedSessions = query({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const handle = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", handle))
      .first();
    if (!user || !user.public_profile_enabled) return [];

    const pinned = await ctx.db
      .query("conversations")
      .withIndex("by_user_profile_pinned", (q) =>
        q.eq("user_id", user._id).gt("profile_pinned_at", 0)
      )
      .order("desc")
      .collect();

    return pinned
      .filter((c) => profilePublicSessionVisible(c))
      .map((c) => ({
        _id: c._id,
        share_token: c.share_token!,
        title: c.title,
        subtitle: c.subtitle,
        repo: basenameOf(c.git_root || c.project_path),
        agent: c.agent_type ?? null,
        message_count: c.message_count ?? 0,
        updated_at: c.updated_at ?? c.started_at ?? c._creationTime,
        profile_pinned_at: c.profile_pinned_at,
      }));
  },
});

// PUBLIC. The anonymized GitHub-style contribution graph: per-day activity
// tally across ALL the user's sessions (private ones count as anonymous squares,
// exactly like GitHub). Each day is only aggregates — hours, session/message
// counts, and a distinct-project COUNT (never names) — so the same rows power
// both the contribution grid and the anonymized "ran N sessions on M projects"
// feed. `projects` is best-effort: only the recent conversations source knows
// paths, so older days report 0 (render-side: omit, don't show "0 projects").
// Honors hide_activity, and only runs once the profile is enabled.
export const getPublicActivityHeatmap = query({
  args: { username: v.string(), days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const handle = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", handle))
      .first();
    if (!user || !user.public_profile_enabled || user.hide_activity) return [];

    const intervals = await collectUserActivityIntervals(
      ctx,
      null,
      { user_id: user._id, days: args.days },
      { countAll: true }
    );

    const buckets: Record<string, { hours: number; sessions: number; msgs: number; projects: Set<string> }> = {};
    for (const iv of intervals) {
      const date = new Date(iv.end).toISOString().split("T")[0];
      const b = (buckets[date] ||= { hours: 0, sessions: 0, msgs: 0, projects: new Set() });
      b.sessions++;
      b.hours += iv.hours;
      b.msgs += iv.msgs;
      if (iv.project) b.projects.add(iv.project);
    }
    return Object.entries(buckets)
      .map(([date, d]) => ({
        date,
        hours: Math.round(d.hours * 100) / 100,
        sessions: d.sessions,
        msgs: Math.round(d.msgs),
        projects: d.projects.size,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export const getUserAbstractActivity = query({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) return null;
    const user = await ctx.db.get(args.user_id);
    if (!user) return null;

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const recentConversationsRaw = args.team_id
      ? await ctx.db
          .query("conversations")
          .withIndex("by_team_user_updated", (q: any) =>
            q.eq("team_id", args.team_id).eq("user_id", args.user_id)
          )
          .order("desc")
          .take(10)
      : await ctx.db
          .query("conversations")
          .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
          .order("desc")
          .take(10);

    // Privacy gate: exclude private conversations from a teammate's profile so
    // their titles/subtitles/projects and counts don't leak (owner sees all).
    const isVisible = await getProfileVisibilityPredicate(ctx, viewerId, args.user_id, args.team_id);
    const recentConversations = recentConversationsRaw.filter(isVisible);

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

    if (args.team_id || user.team_id) {
      const teamEventsRaw = await ctx.db
        .query("team_activity_events")
        .withIndex("by_actor", (q) => q.eq("actor_user_id", args.user_id))
        .order("desc")
        .take(args.team_id ? 60 : 15);
      const teamEvents = args.team_id
        ? teamEventsRaw.filter(e => String(e.team_id) === String(args.team_id)).slice(0, 15)
        : teamEventsRaw;

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

// One credited slice of session activity, normalized across the three sources
// (live conversations, team_activity_events, session_insights). `hours` is the
// capped duration credit (exactly what the day heatmap has always added) and
// `end` is the legacy bucketing timestamp; `start` lets granular consumers
// distribute that credit across the hours the session actually spanned.
// `project` is the repo/folder basename — only the recent `conversations`
// branch knows it (events/insights don't carry a path), so consumers must
// treat it as best-effort. Used solely for anonymized distinct-project COUNTS.
type ActivityInterval = { start: number; end: number; hours: number; msgs: number; project?: string | null };

// Hybrid read strategy shared by the day heatmap and the hour punchcard:
//   - Recent window (last 7 days): stream `conversations` directly.
//     Source of truth for in-progress sessions, but heavy docs
//     (1024-dim title_embedding + git_diff blobs), so we keep the window
//     tight to stay under the 100MB bytes-read cap.
//   - Older days: use lightweight `team_activity_events` and
//     `session_insights` (no embeddings/diffs). They lag real time but
//     have settled by day +1, so they're accurate for historical buckets.
// `preferCompleted` processes session_completed events before session_started
// ones so the record carrying duration + message_count wins the dedupe. The
// legacy day heatmap keeps insertion order (started usually wins) so its
// historical buckets stay stable.
async function collectUserActivityIntervals(
  ctx: any,
  viewerId: Id<"users"> | null,
  args: { user_id: Id<"users">; team_id?: Id<"teams">; days?: number },
  opts?: { preferCompleted?: boolean; countAll?: boolean }
): Promise<ActivityInterval[]> {
  const numDays = args.days ?? 365;
  const now = Date.now();
  const cutoff = now - numDays * 24 * 60 * 60 * 1000;
  const recentCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const HOUR = 3600000;
  const CAP = 8 * HOUR;

  const intervals: ActivityInterval[] = [];
  const seen = new Set<string>();

  // Credit each session on its **last activity day** (`updated_at`), not its
  // start day. This matches the user's mental model — "today's hours" means
  // sessions I was working on today, even if they began earlier in the week.
  // Long sessions are common in this codebase (workflow/orchestrate), so
  // start-day bucketing would hide today's work on multi-day sessions.
  // Subagent/child sessions are included (no parent filter) to match the
  // pre-existing query semantics and the 5422-session header total.
  // Privacy gate: don't count a teammate's private conversations toward their
  // public heatmap (owner sees all). Private convs are still marked `seen` so
  // the events/insights fallback branches below can't re-introduce them.
  // countAll = the anonymized public contribution graph: every session counts
  // (GitHub-style "private contributions" squares), but only as a per-day tally
  // — the caller returns no titles/ids, so nothing about content leaks.
  const isVisible = opts?.countAll
    ? () => true
    : await getProfileVisibilityPredicate(ctx, viewerId!, args.user_id, args.team_id);
  const recentConvos = args.team_id
    ? ctx.db.query("conversations").withIndex("by_team_user_updated", (q: any) =>
        q.eq("team_id", args.team_id).eq("user_id", args.user_id).gte("updated_at", recentCutoff))
    : ctx.db.query("conversations").withIndex("by_user_updated", (q: any) =>
        q.eq("user_id", args.user_id).gte("updated_at", recentCutoff));
  for await (const c of recentConvos) {
    const upd = c.updated_at ?? c.started_at;
    if (!upd) continue;
    seen.add(String(c._id));
    if (!isVisible(c)) continue;
    const durMs = c.started_at ? Math.max(0, upd - c.started_at) : 0;
    intervals.push({
      start: upd - durMs,
      end: upd,
      hours: Math.min(durMs, CAP) / HOUR,
      msgs: c.message_count ?? 0,
      project: basenameOf(c.git_root || c.project_path),
    });
  }

  const events = await ctx.db
    .query("team_activity_events")
    .withIndex("by_actor", (q: any) => q.eq("actor_user_id", args.user_id))
    .collect();

  const eventPasses = opts?.preferCompleted
    ? [
        events.filter((e: any) => e.event_type === "session_completed"),
        events.filter((e: any) => e.event_type === "session_started"),
      ]
    : [events];
  for (const pass of eventPasses) {
    for (const e of pass) {
      if (e.timestamp < cutoff || e.timestamp >= recentCutoff) continue;
      if (args.team_id && String(e.team_id) !== String(args.team_id)) continue;
      if (e.event_type !== "session_started" && e.event_type !== "session_completed") continue;
      const cid = e.related_conversation_id ? String(e.related_conversation_id) : `evt-${e._id}`;
      if (seen.has(cid)) continue;
      seen.add(cid);
      // `e.timestamp` is when the event fired: for `session_completed` that's
      // the end of activity; for `session_started` it's the start. Both are
      // reasonable proxies for "activity day" — the original query used the
      // same field, so historical buckets stay stable across this change.
      const durMs = e.event_type === "session_completed" ? e.metadata?.duration_ms : undefined;
      intervals.push({
        start: e.timestamp - (durMs ?? 0.5 * HOUR),
        end: e.timestamp,
        hours: durMs ? Math.min(durMs, CAP) / HOUR : 0.5,
        msgs: e.metadata?.message_count ?? 0,
      });
    }
  }

  const insights = await ctx.db
    .query("session_insights")
    .withIndex("by_actor_generated_at", (q: any) =>
      q.eq("actor_user_id", args.user_id).gte("generated_at", cutoff)
    )
    .collect();

  for (const ins of insights) {
    if (ins.generated_at >= recentCutoff) continue;
    if (args.team_id && String(ins.team_id) !== String(args.team_id)) continue;
    const cid = String(ins.conversation_id);
    if (seen.has(cid)) continue;
    seen.add(cid);
    intervals.push({ start: ins.generated_at - 0.5 * HOUR, end: ins.generated_at, hours: 0.5, msgs: 0 });
  }

  return intervals;
}

export const getUserActivityHeatmap = query({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) return [];

    const intervals = await collectUserActivityIntervals(ctx, userId, args);

    const buckets: Record<string, { hours: number; sessions: number }> = {};
    for (const iv of intervals) {
      const date = new Date(iv.end).toISOString().split("T")[0];
      if (!buckets[date]) buckets[date] = { hours: 0, sessions: 0 };
      buckets[date].sessions++;
      buckets[date].hours += iv.hours;
    }

    return Object.entries(buckets)
      .map(([date, data]) => ({
        date,
        hours: Math.round(data.hours * 100) / 100,
        sessions: data.sessions,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

// Hour-of-day bucketing shared by the authed and public punchcard queries:
// each session's credit is distributed across the (local date × hour) cells
// its interval overlaps, so the punchcard shows *when during the day* work
// actually happened. `tzOffsetMinutes` is the viewer's Date.getTimezoneOffset()
// — hour-of-day only means something in the viewer's local clock. (One offset
// is applied to the whole range, so cells across a DST switch can shift by an
// hour.) Returns only per-cell aggregates — nothing identifying leaks.
function bucketPunchcardRows(intervals: ActivityInterval[], tzOffsetMinutes: number) {
  const HOUR = 3600000;
  const tzShift = tzOffsetMinutes * 60000;
  const rows: Record<string, { hours: number[]; msgs: number[]; sessions: number[]; day_sessions: number }> = {};

  for (const iv of intervals) {
    // Bound the distribution loop: a zombie conversation idling for weeks
    // still only smears its (already 8h-capped) credit over the final 14d.
    let start = Math.min(iv.start, iv.end);
    if (iv.end - start > 14 * 24 * HOUR) start = iv.end - 14 * 24 * HOUR;
    const ls = start - tzShift;
    const le = iv.end - tzShift;
    const span = le - ls;
    const firstCell = Math.floor(ls / HOUR);
    const lastCell = Math.floor(le / HOUR);
    const touchedDates = new Set<string>();
    for (let cell = firstCell; cell <= lastCell; cell++) {
      const cellStart = cell * HOUR;
      const frac = span <= 0 ? 1 : (Math.min(le, cellStart + HOUR) - Math.max(ls, cellStart)) / span;
      if (frac <= 0) continue;
      const d = new Date(cellStart);
      const date = d.toISOString().split("T")[0];
      const hour = d.getUTCHours();
      const row = (rows[date] ||= {
        hours: new Array(24).fill(0),
        msgs: new Array(24).fill(0),
        sessions: new Array(24).fill(0),
        day_sessions: 0,
      });
      row.hours[hour] += iv.hours * frac;
      row.msgs[hour] += iv.msgs * frac;
      row.sessions[hour]++;
      if (!touchedDates.has(date)) {
        touchedDates.add(date);
        row.day_sessions++;
      }
    }
  }

  return Object.entries(rows)
    .map(([date, r]) => ({
      date,
      hours: r.hours.map((h) => Math.round(h * 100) / 100),
      msgs: r.msgs.map((m) => Math.round(m)),
      sessions: r.sessions,
      day_sessions: r.day_sessions,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const getUserActivityPunchcard = query({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    days: v.optional(v.number()),
    tz_offset_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) return [];

    const intervals = await collectUserActivityIntervals(ctx, userId, args, { preferCompleted: true });
    return bucketPunchcardRows(intervals, args.tz_offset_minutes ?? 0);
  },
});

// PUBLIC. The anonymized hour-of-day punchcard for /u/<handle> profile pages:
// same countAll aggregation as the public heatmap (every session counts, no
// identities), distributed across local-clock hour cells like the authed
// Timeline tab. Gated identically: opt-in profile + activity not hidden.
export const getPublicActivityPunchcard = query({
  args: {
    username: v.string(),
    days: v.optional(v.number()),
    tz_offset_minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const handle = args.username.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", handle))
      .first();
    if (!user || !user.public_profile_enabled || user.hide_activity) return [];

    const intervals = await collectUserActivityIntervals(
      ctx,
      null,
      { user_id: user._id, days: args.days },
      { preferCompleted: true, countAll: true }
    );
    return bucketPunchcardRows(intervals, args.tz_offset_minutes ?? 0);
  },
});

export const getUserTasks = query({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) return [];
    const limit = Math.min(args.limit ?? 20, 50);
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(limit);
    return tasks.map((t: any) => ({
      _id: t._id,
      short_id: t.short_id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      labels: t.labels,
      created_at: t.created_at || t._creationTime,
      updated_at: t.updated_at,
      closed_at: t.closed_at,
    }));
  },
});

export const getUserDocs = query({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const user = await ctx.db.get(args.user_id);
    if (!user || user.hide_activity) return [];
    const limit = Math.min(args.limit ?? 20, 50);
    const docs = await ctx.db
      .query("docs")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(limit);
    return docs
      .filter((d: any) => !d.archived_at)
      .map((d: any) => ({
        _id: d._id,
        title: d.title,
        doc_type: d.doc_type,
        labels: d.labels,
        created_at: d.created_at || d._creationTime,
        updated_at: d.updated_at,
      }));
  },
});

type ProfileFeedItem = {
  type: string;
  timestamp: number;
  verb: string;
  preview?: string;
  entity_id?: string;
  entity_type?: string;
  entity_title?: string;
  entity_short_id?: string;
  count?: number;
  meta?: Record<string, any>;
};

export const getUserProfileFeed = query({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // Deployed web bundles (and the remote-URL Electron shell) outlive convex
    // deploys by days — accept the pre-pagination {limit} shape and answer it
    // with the pre-pagination array return. The export is cast below so the
    // generated types only advertise the paginated signature.
    paginationOpts: v.optional(paginationOptsValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const legacy = !args.paginationOpts;
    const legacyLimit = Math.min(args.limit ?? 30, 200);
    const paginationOpts = args.paginationOpts ?? { numItems: 30, cursor: null };
    const empty = legacy ? [] : { page: [], isDone: true, continueCursor: "" };
    const userId = await getAuthUserId(ctx);
    if (!userId) return empty;
    const user = await ctx.db.get(args.user_id);
    if (!user) return empty;

    const items: ProfileFeedItem[] = [];

    // Messages are the spine of the feed, so we paginate over the user's
    // conversations (newest first) and pull each page's user-authored messages.
    // The activity overlay (tasks/docs/commits) is appended only on the first
    // page so it sits at the top without re-fetching on every "load more".
    const isFirstPage = !paginationOpts.cursor;
    const convoQuery = args.team_id
      ? ctx.db
          .query("conversations")
          .withIndex("by_team_user_updated", (q: any) =>
            q.eq("team_id", args.team_id).eq("user_id", args.user_id)
          )
          .order("desc")
      : ctx.db
          .query("conversations")
          .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
          .order("desc");
    const convoPage = await convoQuery.paginate(paginationOpts);

    // Privacy gate: (team_id, user_id) is routing, not visibility. Drop private
    // conversations so a teammate's profile never exposes their message text.
    const isVisible = await getProfileVisibilityPredicate(ctx, userId, args.user_id, args.team_id);
    const recentConvos = convoPage.page.filter(isVisible);

    const NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "Your task is to create a detailed summary", "Full transcript available at:", "Read the output file to retrieve the result:", "[Codecast import]"];
    const COMMAND_RE = /^(<command-name>|<command-message>|<local-command-stdout>|<local-command-stderr>|Caveat:|\/[a-z][\w-]*)/i;
    const SKILL_RE = /Base directory for this skill:\s/;
    function stripTags(s: string): string {
      return s
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
        .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
        .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
        .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
        .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, "")
        .replace(/^\s*Caveat:.*$/gm, "")
        .trim();
    }
    function isNoise(content: string): boolean {
      if (!content) return true;
      const t = content.trim();
      if (!t) return true;
      // Session→session messages (cast send) land as user-role turns wrapped in
      // <session-message from="..">. They're agent coordination, not something the
      // human typed into this session — drop them from "what I wrote".
      if (t.startsWith("<session-message")) return true;
      if (COMMAND_RE.test(t)) return true;
      if (SKILL_RE.test(t)) return true;
      if (t.startsWith("<task-notification>") && !t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").trim()) return true;
      if (t.startsWith("{") && t.includes("__cc_poll")) return true;
      if (t.includes("Your task is to create a detailed summary of the conversation so far")) return true;
      const stripped = stripTags(t);
      if (!stripped) return true;
      if (NOISE_PREFIXES.some(p => stripped.startsWith(p))) return true;
      return false;
    }

    for (const c of recentConvos) {
      if ((c as any).parent_conversation_id) continue;
      const allMsgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q: any) =>
          q.eq("conversation_id", c._id)
        )
        .order("desc")
        .take(40);
      const sessionMeta = { message_count: c.message_count, project: c.project_path?.split("/").pop(), status: c.status, duration_ms: c.started_at && c.updated_at ? c.updated_at - c.started_at : undefined };
      for (let i = 0; i < allMsgs.length; i++) {
        const m = allMsgs[i];
        if (m.role !== "user") continue;
        if (m.from_user_id && String(m.from_user_id) !== String(args.user_id)) continue;
        if (!m.content || isNoise(m.content)) continue;
        if (m.tool_results && m.tool_results.length > 0 && (!m.content || !m.content.trim())) continue;
        const prev = allMsgs[i + 1];
        if (prev?.role === "assistant" && prev?.tool_calls?.some((tc: any) => tc.name === "Task" || tc.name === "Agent")) continue;
        const content = stripTags(m.content);
        if (!content) continue;
        items.push({
          type: "message",
          timestamp: m.timestamp || m._creationTime,
          verb: "messaged",
          preview: content,
          entity_id: String(c._id),
          entity_type: "session",
          entity_title: c.title || "Untitled",
          meta: sessionMeta,
        });
      }
    }

    if (isFirstPage) {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(20);
    for (const t of tasks as any[]) {
      if (args.team_id && t.team_id && String(t.team_id) !== String(args.team_id)) continue;
      items.push({
        type: "task",
        timestamp: t.updated_at || t.created_at || t._creationTime,
        verb: t.status === "done" ? "completed" : t.updated_at > t.created_at + 1000 ? "updated" : "created",
        entity_id: String(t._id),
        entity_type: "task",
        entity_title: t.title,
        entity_short_id: t.short_id,
        meta: { status: t.status, priority: t.priority },
      });
    }

    const docs = await ctx.db
      .query("docs")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(15);
    for (const d of docs as any[]) {
      if (d.archived_at) continue;
      if (args.team_id && d.team_id && String(d.team_id) !== String(args.team_id)) continue;
      items.push({
        type: "doc",
        timestamp: d.updated_at || d.created_at || d._creationTime,
        verb: d.updated_at > (d.created_at || d._creationTime) + 1000 ? "edited" : "wrote",
        entity_id: String(d._id),
        entity_type: "doc",
        entity_title: d.title || "Untitled",
        meta: { doc_type: d.doc_type },
      });
    }

    const teamEvents = await ctx.db
      .query("team_activity_events")
      .withIndex("by_actor", (q) => q.eq("actor_user_id", args.user_id))
      .order("desc")
      .take(20);
    for (const e of teamEvents) {
      if (args.team_id && String(e.team_id) !== String(args.team_id)) continue;
      const typeMap: Record<string, string> = {
        commit_pushed: "pushed",
        pr_created: "opened PR",
        pr_merged: "merged PR",
        session_started: "started",
        session_completed: "finished",
      };
      if (!typeMap[e.event_type]) continue;
      items.push({
        type: e.event_type,
        timestamp: e.timestamp,
        verb: typeMap[e.event_type],
        preview: e.title,
        entity_id: e.related_conversation_id ? String(e.related_conversation_id) : undefined,
        entity_type: e.related_conversation_id ? "session" : undefined,
        meta: {
          branch: e.metadata?.git_branch,
          files_changed: e.metadata?.files_changed,
          pr_number: e.related_pr_id,
        },
      });
    }
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    if (legacy) return items.slice(0, legacyLimit);
    return { page: items, isDone: convoPage.isDone, continueCursor: convoPage.continueCursor };
  },
  // The runtime validator above also tolerates legacy {limit} callers, but the
  // advertised type is paginated-only so usePaginatedQuery accepts it and new
  // callers are steered to paginationOpts.
}) as unknown as RegisteredQuery<
  "public",
  { user_id: Id<"users">; team_id?: Id<"teams">; paginationOpts: PaginationOptions },
  Promise<PaginationResult<ProfileFeedItem>>
>;

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

const DIRECTORY_MATCH_BATCH_SIZE = 32;

function matchesPathPrefix(projectPath: string | null | undefined, pathPrefix: string) {
  return !!projectPath && (
    projectPath === pathPrefix ||
    projectPath.startsWith(pathPrefix + "/")
  );
}

function getConversationProjectPath(conv: { git_root?: string | null; project_path?: string | null }) {
  return conv.git_root || conv.project_path || null;
}

function getPathPrefixUpperBound(pathPrefix: string) {
  return `${pathPrefix}\uffff`;
}

function getRepoNameFromPath(path: string | null | undefined) {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part.startsWith(".")) {
      return part.toLowerCase();
    }
  }
  return null;
}

function getRepoKeyFromRemote(remote: string | null | undefined) {
  if (!remote) return null;
  const normalized = remote.trim().replace(/\/+$/, "");
  const githubMatch = normalized.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  if (githubMatch?.[1]) {
    return githubMatch[1].toLowerCase();
  }
  const genericMatch = normalized.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return genericMatch?.[1]?.toLowerCase() || null;
}

async function getMatchingConversationsPage(
  ctx: any,
  userId: any,
  pathPrefix: string,
  source: "git_root" | "project_path",
  cursor?: string,
  numItems = DIRECTORY_MATCH_BATCH_SIZE,
) {
  const field = source === "git_root" ? "git_root" : "project_path";
  const index = source === "git_root" ? "by_user_git_root" : "by_user_project_path";
  const page = await ctx.db
    .query("conversations")
    .withIndex(index, (q: any) =>
      q
        .eq("user_id", userId)
        .gte(field, pathPrefix)
        .lt(field, getPathPrefixUpperBound(pathPrefix))
    )
    .paginate({
      cursor: (cursor || null) as any,
      numItems,
    });

  const matches = page.page.filter((conv: any) => {
    if (source === "project_path" && conv.git_root) {
      return false;
    }
    return matchesPathPrefix(getConversationProjectPath(conv), pathPrefix);
  });

  return { page: matches, isDone: page.isDone, continueCursor: page.continueCursor };
}

async function findNextConversationForPath(
  ctx: any,
  userId: any,
  pathPrefix: string,
) {
  for (const source of ["git_root", "project_path"] as const) {
    let cursor: string | undefined;
    while (true) {
      const page = await getMatchingConversationsPage(ctx, userId, pathPrefix, source, cursor, 16);
      if (page.page.length > 0) {
        return page.page[0];
      }
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
  }
  return null;
}

// Queue a full re-resolution of every conversation whose path matches
// `pathPrefix`. Used after any mapping mutation (add/update/remove) — the
// backfill reads the *current* mappings and recomputes team_id/is_private/
// auto_shared per conversation, so it correctly handles longer-prefix
// precedence and falls back to teamless when no mapping matches anymore.
async function queueRetroactiveResolveConversations(
  ctx: any,
  userId: any,
  pathPrefix: string,
) {
  await ctx.scheduler.runAfter(0, internal.users.backfillDirectoryTeamMappingConversations, {
    user_id: userId,
    path_prefix: pathPrefix,
    source: "git_root",
  });
}

export const backfillDirectoryTeamMappingConversations = internalMutation({
  args: {
    user_id: v.id("users"),
    path_prefix: v.string(),
    // Legacy arg — ignored. The backfill re-resolves from current mappings.
    team_id: v.optional(v.id("teams")),
    source: v.optional(v.union(v.literal("git_root"), v.literal("project_path"))),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const source = args.source || "git_root";
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .collect();
    const page = await getMatchingConversationsPage(
      ctx,
      args.user_id,
      args.path_prefix,
      source,
      args.cursor,
    );

    let updated = 0;
    for (const conv of page.page) {
      const convPath = conv.git_root || conv.project_path;
      if (!convPath) continue;
      const { teamId, isPrivate, autoShared } = resolveTeamForPath(mappings, convPath, undefined);

      const patch: Record<string, unknown> = {};
      const newTeam = teamId ? teamId.toString() : null;
      const oldTeam = conv.team_id ? conv.team_id.toString() : null;
      if (newTeam !== oldTeam) patch.team_id = teamId ?? undefined;
      if ((conv.is_private ?? true) !== isPrivate) patch.is_private = isPrivate;
      if ((conv.auto_shared ?? false) !== autoShared) patch.auto_shared = autoShared;

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(conv._id, patch);
        updated++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.users.backfillDirectoryTeamMappingConversations, {
        user_id: args.user_id,
        path_prefix: args.path_prefix,
        source,
        cursor: page.continueCursor,
      });
    } else if (source === "git_root") {
      await ctx.scheduler.runAfter(0, internal.users.backfillDirectoryTeamMappingConversations, {
        user_id: args.user_id,
        path_prefix: args.path_prefix,
        source: "project_path",
      });
    }

    return {
      updated,
      source,
      isDone: page.isDone && source === "project_path",
      continueCursor: page.isDone ? undefined : page.continueCursor,
    };
  },
});

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
    // Re-resolve conversations under every mapping — not just auto_share ones.
    // The shared backfill reads current mappings and applies the right
    // is_private/auto_shared values per conversation.
    for (const mapping of mappings) {
      await queueRetroactiveResolveConversations(
        ctx, mapping.user_id, mapping.path_prefix
      );
    }
    return { totalUpdated: 0, mappingsProcessed: mappings.length };
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
        await queueRetroactiveResolveConversations(ctx, userId, args.path_prefix);
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

    // Re-resolve every matching conversation against current mappings,
    // regardless of auto_share — the backfill applies the new mapping's
    // is_private/auto_shared values per conversation.
    await queueRetroactiveResolveConversations(ctx, userId, args.path_prefix);

    return {
      success: true,
      updated: !!existingMapping,
      created: !existingMapping,
      retroactivelyShared: 0,
      retroactiveQueued: true,
    };
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
    let hasMore = false;
    if (args.delete_conversations) {
      const result = await deleteConversationsForPathInternal(ctx, userId, args.path_prefix);
      conversationsDeleted = result.conversationsDeleted;
      messagesDeleted = result.messagesDeleted;
      hasMore = result.hasMore;
    } else if (mapping) {
      // Mapping was removed but conversations kept — re-resolve them so they
      // either pick up a parent mapping or fall back to personal (no team).
      await queueRetroactiveResolveConversations(ctx, userId, args.path_prefix);
    }

    return { success: true, conversationsDeleted, messagesDeleted, hasMore };
  },
});

async function deleteConversationsForPathInternal(
  ctx: any,
  userId: any,
  pathPrefix: string,
) {
  const conv = await findNextConversationForPath(ctx, userId, pathPrefix);

  if (!conv) {
    return { conversationsDeleted: 0, messagesDeleted: 0, hasMore: false };
  }

  const MSG_BATCH = 100;
  const msgs = await ctx.db
    .query("messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .take(MSG_BATCH);

  for (const msg of msgs) {
    await ctx.db.delete(msg._id);
  }

  if (msgs.length === MSG_BATCH) {
    return { conversationsDeleted: 0, messagesDeleted: msgs.length, hasMore: true };
  }

  await ctx.db.delete(conv._id);
  const nextConv = await findNextConversationForPath(ctx, userId, pathPrefix);
  return { conversationsDeleted: 1, messagesDeleted: msgs.length, hasMore: !!nextConv };
}

async function countConversationsForPathInternal(
  ctx: any,
  userId: any,
  pathPrefix: string,
) {
  const seen = new Set<string>();
  let count = 0;

  for (const source of ["git_root", "project_path"] as const) {
    let cursor: string | undefined;
    while (true) {
      const page = await getMatchingConversationsPage(ctx, userId, pathPrefix, source, cursor, 32);
      for (const conv of page.page) {
        const id = conv._id.toString();
        if (seen.has(id)) continue;
        seen.add(id);
        count++;
      }
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
  }

  return count;
}

export const countConversationsForPath = query({
  args: {
    path_prefix: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { count: 0 };
    return { count: await countConversationsForPathInternal(ctx, userId, args.path_prefix) };
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

export const getSuggestedTeamProjects = query({
  args: {
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }

    const teamId = args.team_id || user.active_team_id || user.team_id;
    if (!teamId) {
      return null;
    }

    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", teamId))
      .unique();
    if (!membership) {
      return null;
    }

    const team = await ctx.db.get(teamId);
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
      .collect();

    const currentUserMappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const mappingByPath = new Map(currentUserMappings.map((mapping) => [mapping.path_prefix, mapping]));

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(200);

    const projectMap = new Map<string, {
      path: string;
      git_remote_url?: string;
      session_count: number;
      last_active: number;
      repo_key: string | null;
      repo_name: string | null;
    }>();

    for (const conv of conversations) {
      const path = getConversationProjectPath(conv);
      if (!path) continue;

      const existing = projectMap.get(path);
      if (existing) {
        existing.session_count++;
        existing.last_active = Math.max(existing.last_active, conv.updated_at);
        if (!existing.git_remote_url && conv.git_remote_url) {
          existing.git_remote_url = conv.git_remote_url;
          existing.repo_key = getRepoKeyFromRemote(conv.git_remote_url);
        }
        continue;
      }

      projectMap.set(path, {
        path,
        git_remote_url: conv.git_remote_url,
        session_count: 1,
        last_active: conv.updated_at,
        repo_key: getRepoKeyFromRemote(conv.git_remote_url),
        repo_name: getRepoNameFromPath(path),
      });
    }

    const repoKeySignals = new Map<string, { members: Set<string> }>();
    const repoNameSignals = new Map<string, { members: Set<string> }>();
    const registerSignal = (
      store: Map<string, { members: Set<string> }>,
      key: string | null,
      memberId: string,
    ) => {
      if (!key) return;
      const existing = store.get(key) || { members: new Set<string>() };
      existing.members.add(memberId);
      store.set(key, existing);
    };

    for (const member of memberships) {
      if (member.user_id.toString() === userId.toString()) {
        continue;
      }

      const sharedConversations = await ctx.db
        .query("conversations")
        .withIndex("by_team_user_updated", (q) => q.eq("team_id", teamId).eq("user_id", member.user_id))
        .order("desc")
        .take(40);

      for (const conv of sharedConversations) {
        if (conv.is_private) continue;
        const path = getConversationProjectPath(conv);
        if (!path) continue;
        const memberKey = member.user_id.toString();
        registerSignal(repoKeySignals, getRepoKeyFromRemote(conv.git_remote_url), memberKey);
        registerSignal(repoNameSignals, getRepoNameFromPath(path), memberKey);
      }
    }

    const mappingsForTeam = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
      .collect();
    for (const mapping of mappingsForTeam) {
      if (mapping.user_id.toString() === userId.toString()) {
        continue;
      }
      registerSignal(repoNameSignals, getRepoNameFromPath(mapping.path_prefix), mapping.user_id.toString());
    }

    const suggestions = Array.from(projectMap.values())
      .map((project) => {
        const currentMapping = mappingByPath.get(project.path);
        if (currentMapping?.team_id?.toString() === teamId.toString()) {
          return null;
        }

        const repoKeySignal = project.repo_key ? repoKeySignals.get(project.repo_key) : null;
        const repoNameSignal = project.repo_name ? repoNameSignals.get(project.repo_name) : null;
        const signal = repoKeySignal || repoNameSignal;
        if (!signal) {
          return null;
        }

        const matched_member_count = signal.members.size;
        const match_type = repoKeySignal ? "github" : "repo_name";
        const match_reason = repoKeySignal
          ? `${matched_member_count} teammate${matched_member_count === 1 ? "" : "s"} already share ${project.repo_key}`
          : `${matched_member_count} teammate${matched_member_count === 1 ? "" : "s"} already share ${project.repo_name}`;

        return {
          path: project.path,
          git_remote_url: project.git_remote_url || null,
          session_count: project.session_count,
          last_active: project.last_active,
          matched_member_count,
          match_type,
          match_reason,
          current_team_id: currentMapping?.team_id || null,
        };
      })
      .filter((project): project is NonNullable<typeof project> => project !== null)
      .sort((a, b) => {
        if (b.matched_member_count !== a.matched_member_count) {
          return b.matched_member_count - a.matched_member_count;
        }
        if (a.match_type !== b.match_type) {
          return a.match_type === "github" ? -1 : 1;
        }
        return b.last_active - a.last_active;
      })
      .slice(0, 8);

    // Collect team repos the user doesn't have locally
    const userRepoKeys = new Set<string>();
    for (const project of projectMap.values()) {
      if (project.repo_key) userRepoKeys.add(project.repo_key);
    }

    const teamOnlyRepos: { repo_key: string; repo_name: string; member_count: number }[] = [];
    for (const [key, signal] of repoKeySignals) {
      if (!userRepoKeys.has(key)) {
        const name = key.split("/").pop() || key;
        teamOnlyRepos.push({
          repo_key: key,
          repo_name: name,
          member_count: signal.members.size,
        });
      }
    }
    teamOnlyRepos.sort((a, b) => b.member_count - a.member_count);

    return {
      team_id: teamId,
      team_name: team?.name || "Team",
      team_icon: team?.icon || null,
      team_icon_color: team?.icon_color || null,
      current_visibility: membership.visibility || "summary",
      suggestions,
      team_only_repos: teamOnlyRepos.slice(0, 6),
    };
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
    const threeWeeksAgo = Date.now() - 21 * 24 * 60 * 60 * 1000;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", userId).gte("updated_at", threeWeeksAgo)
      )
      .order("desc")
      .take(200);

    // Hide paths none of the user's machines can see locally. Read the union of
    // online devices' roots (NOT the per-user field, which every daemon clobbers
    // on each heartbeat — that made the list flip-flop between machines). Empty
    // union (no device online/reporting) → don't filter: showing too much beats
    // showing nothing.
    const onlineRoots = await getOnlineLocalRoots(ctx, userId);
    const localRootSet = onlineRoots.length > 0 ? new Set(onlineRoots) : null;

    const pathCounts = new Map<string, { count: number; lastActive: number }>();
    for (const conv of conversations) {
      const raw = conv.git_root || conv.project_path;
      if (!raw) continue;
      const path = normalizeProjectPath(raw);
      if (!path) continue;
      if (localRootSet && !localRootSet.has(path)) continue;
      const existing = pathCounts.get(path);
      if (existing) {
        existing.count++;
        existing.lastActive = Math.max(existing.lastActive, conv.updated_at);
      } else {
        pathCounts.set(path, { count: 1, lastActive: conv.updated_at });
      }
    }

    const entries = Array.from(pathCounts.entries());
    const maxCount = Math.max(1, ...entries.map(([, s]) => s.count));
    const now = Date.now();
    const ageRange = now - threeWeeksAgo;

    return entries
      .map(([path, stats]) => ({
        path,
        count: stats.count,
        lastActive: stats.lastActive,
        score:
          0.65 * (stats.count / maxCount) +
          0.35 * ((stats.lastActive - threeWeeksAgo) / ageRange),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ path, count, lastActive }) => ({
        path,
        count,
        lastActive,
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
    // The polling daemon's device id. Commands targeted at another device are
    // filtered out so only the owning daemon executes session commands. This is
    // the real-time twin of the heartbeat poll's routing filter. Optional for
    // backward compat: a daemon that omits it only sees untargeted commands.
    device_id: v.optional(v.string()),
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
      .filter(
        (c) =>
          // Rollout-safe: a daemon that doesn't identify itself sees everything.
          args.device_id === undefined ||
          c.target_device_id === undefined ||
          c.target_device_id === args.device_id,
      )
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

    const commandId = await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: args.agent_type,
      projectPath: args.project_path,
      sessionId,
      prompt: args.prompt,
      createdAt: now,
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
        await queueRetroactiveResolveConversations(ctx, result.userId, args.path_prefix);
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

    // Re-resolve every matching conversation against current mappings,
    // regardless of auto_share — see updateDirectoryTeamMapping for rationale.
    await queueRetroactiveResolveConversations(ctx, result.userId, args.path_prefix);

    return {
      success: true,
      action: existingMapping ? "updated" : "created",
      retroactivelyShared: 0,
      retroactiveQueued: true,
    };
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
    return { count: await countConversationsForPathInternal(ctx, result.userId, args.path_prefix) };
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

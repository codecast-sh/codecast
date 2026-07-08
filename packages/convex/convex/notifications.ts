import { mutation, query, internalAction, internalMutation } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { isConversationTeamVisible } from "./privacy";
import { isAgentSpawnedConversation } from "./ccAccountsShared";
import {
  trustedAgentStatus,
  deriveSessionActivity,
  classifyWorkState,
  needsInputKind,
  subagentKeepsParentWorking,
  HEARTBEAT_ALIVE_MS,
} from "./inboxFilters";

export const sendPushNotification = internalAction({
  args: {
    push_token: v.string(),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const message = {
      to: args.push_token,
      sound: 'default',
      title: args.title,
      body: args.body,
      data: args.data || {},
    };

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      const responseData = await response.json();
      return responseData;
    } catch (error) {
      console.error('Error sending push notification:', error);
      throw error;
    }
  },
});

export const notifyTeamSessionStart = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !conversation.team_id) {
      return;
    }

    // Never notify about agent-spawned sessions — only human-initiated ones.
    if (isAgentSpawnedConversation(conversation)) {
      return;
    }

    // Fire time = registration + a 60s grace delay (see createConversation),
    // so of this budget ~4min covers registration lag.
    const STALE_MS = 5 * 60 * 1000;
    if (conversation.started_at && Date.now() - conversation.started_at > STALE_MS) {
      return;
    }

    if (!(await isConversationTeamVisible(ctx, conversation))) {
      return;
    }

    const user = await ctx.db.get(args.user_id);
    if (!user) {
      return;
    }

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", conversation.team_id))
      .collect();
    const memberUsers = await Promise.all(
      memberships
        .filter((m: any) => m.user_id.toString() !== args.user_id.toString())
        .map((m: any) => ctx.db.get(m.user_id))
    );
    const teamMembers = memberUsers.filter((u: any): u is NonNullable<typeof u> => u !== null);

    const actorName = user.name || user.email || "Someone";
    let body = conversation.title || conversation.project_path?.split("/").pop() || "New session";
    if (!conversation.title) {
      const firstMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", args.conversation_id))
        .order("asc")
        .first();
      if (firstMsg?.content) {
        body = firstMsg.content.slice(0, 200);
      }
    }

    const THROTTLE_MS = 15 * 60 * 1000;
    const now = Date.now();

    for (const member of teamMembers) {
      if (member.muted_members?.includes(args.user_id)) {
        continue;
      }
      if (member.notification_preferences?.team_session_start === false) {
        continue;
      }

      await ctx.db.insert("notifications", {
        recipient_user_id: member._id,
        type: "team_session_start",
        actor_user_id: args.user_id,
        conversation_id: args.conversation_id,
        message: body,
        read: false,
        created_at: now,
      });

      if (member.push_token && member.notifications_enabled) {
        const recentNotifs = await ctx.db
          .query("notifications")
          .withIndex("by_recipient_created", (q: any) =>
            q.eq("recipient_user_id", member._id).gte("created_at", now - THROTTLE_MS)
          )
          .collect();
        const alreadyPushed = recentNotifs.some(
          (n: any) =>
            n.type === "team_session_start" &&
            n.actor_user_id?.toString() === args.user_id.toString() &&
            n.conversation_id?.toString() !== args.conversation_id.toString()
        );

        if (!alreadyPushed) {
          await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
            push_token: member.push_token,
            title: `${actorName} started coding`,
            body,
            data: {
              conversationId: args.conversation_id,
              type: 'team_session_start',
            },
          });
        }
      }
    }
  },
});

// internal: had zero callers and was a public mutation that let anyone deliver
// an arbitrary-text notification to any user (spam/phishing). Real notifications
// are created by the internal mutations and server-side inserts in this file and
// in agentTasks/notificationRouter.
export const create = internalMutation({
  args: {
    recipient_user_id: v.id("users"),
    type: v.union(
      v.literal("mention"),
      v.literal("comment_reply"),
      v.literal("conversation_comment"),
      v.literal("team_invite"),
      v.literal("session_idle"),
      v.literal("permission_request"),
      v.literal("session_error"),
      v.literal("team_session_start"),
      v.literal("task_completed"),
      v.literal("task_failed"),
      v.literal("task_assigned"),
      v.literal("task_status_changed"),
      v.literal("task_commented"),
      v.literal("doc_updated"),
      v.literal("doc_commented"),
      v.literal("plan_status_changed"),
      v.literal("plan_task_completed")
    ),
    actor_user_id: v.optional(v.id("users")),
    comment_id: v.optional(v.id("comments")),
    conversation_id: v.optional(v.id("conversations")),
    entity_type: v.optional(v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation")
    )),
    entity_id: v.optional(v.string()),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const recipient = await ctx.db.get(args.recipient_user_id);
    if (!recipient) {
      throw new Error("Recipient not found");
    }

    const prefs = recipient.notification_preferences;
    if (args.type === "mention" && prefs && !prefs.mention) {
      return null;
    }

    // Skip if recipient has muted this actor
    if (args.actor_user_id && recipient.muted_members?.includes(args.actor_user_id)) {
      return null;
    }

    const notificationId = await ctx.db.insert("notifications", {
      recipient_user_id: args.recipient_user_id,
      type: args.type,
      actor_user_id: args.actor_user_id,
      comment_id: args.comment_id,
      conversation_id: args.conversation_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      message: args.message,
      read: false,
      created_at: Date.now(),
    });

    return notificationId;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_created", (q) => q.eq("recipient_user_id", userId))
      .order("desc")
      .take(50);

    const enriched = await Promise.all(
      notifications.map(async (notification) => {
        const actor = notification.actor_user_id
          ? await ctx.db.get(notification.actor_user_id)
          : null;
        const conversation = notification.conversation_id
          ? await ctx.db.get(notification.conversation_id)
          : null;
        return {
          ...notification,
          actor: actor ? {
            _id: actor._id,
            name: actor.name,
            github_username: actor.github_username,
            github_avatar_url: actor.github_avatar_url,
          } : null,
          conversation: conversation ? {
            title: conversation.title,
            project_path: conversation.project_path,
            agent_type: conversation.agent_type,
          } : null,
        };
      })
    );

    return enriched;
  },
});

export const getUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }

    const unreadNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_read", (q) =>
        q.eq("recipient_user_id", userId).eq("read", false)
      )
      .collect();

    return unreadNotifications.length;
  },
});

export const markAsRead = mutation({
  args: {
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const notification = await ctx.db.get(args.notificationId);
    if (!notification) {
      throw new Error("Notification not found");
    }

    if (notification.recipient_user_id !== userId) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.notificationId, { read: true });
  },
});

export const markAllAsRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const unreadNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_read", (q) =>
        q.eq("recipient_user_id", userId).eq("read", false)
      )
      .collect();

    await Promise.all(
      unreadNotifications.map((notification) =>
        ctx.db.patch(notification._id, { read: true })
      )
    );
  },
});

type SessionNotifType = "session_idle" | "permission_request" | "session_error";

function sessionNotifOptedOut(
  prefs: Record<string, any> | undefined,
  type: SessionNotifType,
): boolean {
  if (type === "session_idle") return prefs?.session_idle === false;
  if (type === "session_error") return prefs?.session_error === false;
  return !!prefs && !prefs.permission_request;
}

// Insert the notification row + push for ONE recipient, honoring their prefs.
// Shared by the api-token mutation below (daemon-driven permission/error
// notifications) and the server-side needs-input check.
async function deliverSessionNotification(
  ctx: any,
  recipientId: any,
  conversationId: any,
  type: SessionNotifType,
  title: string,
  message: string,
): Promise<boolean> {
  const user = await ctx.db.get(recipientId);
  if (!user) return false;
  if (sessionNotifOptedOut(user.notification_preferences as any, type)) return false;

  await ctx.db.insert("notifications", {
    recipient_user_id: recipientId,
    type,
    conversation_id: conversationId,
    message,
    read: false,
    created_at: Date.now(),
  });

  if (user.push_token && user.notifications_enabled) {
    await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
      push_token: user.push_token,
      title,
      body: message,
      data: {
        conversationId,
        type,
      },
    });
  }
  return true;
}

// Row owner + assigned owner. Second-party ownership: the assigned owner is
// the one actually waiting on this session (a Mr Bot fix session parking with
// "ready to ship?"), so mirror the notification to them — same prefs gates,
// their own row+push.
async function deliverSessionNotificationToParties(
  ctx: any,
  conversation: { _id: any; user_id: any; owner_user_id?: any },
  type: SessionNotifType,
  title: string,
  message: string,
): Promise<boolean> {
  let delivered = await deliverSessionNotification(
    ctx, conversation.user_id, conversation._id, type, title, message,
  );
  const ownerUserId = conversation.owner_user_id;
  if (ownerUserId && ownerUserId.toString() !== conversation.user_id.toString()) {
    if (await deliverSessionNotification(ctx, ownerUserId, conversation._id, type, title, message)) {
      delivered = true;
    }
  }
  return delivered;
}

export const createSessionNotification = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.id("conversations"),
    type: v.union(
      v.literal("session_idle"),
      v.literal("permission_request"),
      v.literal("session_error")
    ),
    title: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) {
      return { error: "Unauthorized" };
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id !== auth.userId) {
      return { error: "Not found" };
    }

    const delivered = await deliverSessionNotificationToParties(
      ctx, conversation, args.type, args.title, args.message,
    );

    // Stamp the needs-input dedupe key so the server-side check
    // (checkNeedsInput) stands down for the episode this push already covered:
    // "session_idle" here is the legacy no-hook watcher path, and a
    // "permission_request" push covers the permission_blocked flavor even if
    // the pending_permissions record is slow to land.
    const dedupeKind =
      args.type === "session_idle" ? "idle" :
      args.type === "permission_request" ? "permission_blocked" : null;
    if (dedupeKind) {
      await ctx.db.patch(args.conversation_id, {
        needs_input_notified_key: `${conversation.message_count || 0}:${dedupeKind}`,
      });
    }

    if (delivered && args.type === "session_idle") {
      await ctx.scheduler.runAfter(0, internal.idleSummary.generateIdleSummary, {
        conversation_id: args.conversation_id,
      });
    }

    return delivered ? { notified: true } : { skipped: true };
  },
});

// ── Needs-input push ─────────────────────────────────────────────────────────
//
// Pushes "this session is waiting on you" when a session TRANSITIONS into the
// inbox's needs-input bucket — the same classification that drives the web
// inbox grouping and its idle sound (classifyWorkState server-side;
// isSessionWaitingForInput / waitingSoundKey are the client mirrors). The
// daemon can't own this: it only reports raw agent_status, and "needs input"
// is a composite verdict (status + idle grace + queued messages + open polls)
// that can settle 45s AFTER the last write. So the write sites SCHEDULE a
// re-check — managedSessions.updateAgentStatus / heartbeat on a status change,
// messages.addMessages on an AskUserQuestion arrival — and this mutation
// recomputes the verdict at fire time. Deduped per (message_count, kind), the
// idle sound's exact key: one waiting episode pushes once, each new turn can
// push again.
//
// Exported as a plain function so the fake-db tests can drive the real logic
// (same pattern as pendingMessages).
export async function performNeedsInputCheck(
  ctx: any,
  args: { conversation_id: any; status_ts?: number },
): Promise<{ notified: boolean; reason?: string }> {
  const conv = await ctx.db.get(args.conversation_id);
  if (!conv || !conv.message_count) return { notified: false, reason: "no_content" };
  // Triaged/parked rows don't chime on the web either.
  if (conv.inbox_dismissed_at || conv.inbox_stashed_at) return { notified: false, reason: "dismissed" };
  // The sound skips pinned too (isSessionWaitingForInput's !is_pinned arms).
  if (conv.inbox_pinned_at) return { notified: false, reason: "pinned" };
  // Mirror of the web's isSub guard (inboxStore) — the idle sound skips these,
  // so the push does too: subagents and any parent-linked or worktree session
  // (orchestration workers). Broader than the "hidden subagent" test on
  // purpose; parity with the sound is the contract here.
  if (conv.is_subagent || conv.is_workflow_sub || conv.parent_conversation_id || conv.worktree_name) {
    return { notified: false, reason: "subagent" };
  }

  const session = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
    .first();
  // Scheduled off a specific status change: if the status has moved since, the
  // newer write has its own check in flight — this one is stale.
  if (args.status_ts !== undefined && session?.agent_status_updated_at !== args.status_ts) {
    return { notified: false, reason: "superseded" };
  }

  const now = Date.now();
  // Single-row mirror of enrichInboxSessionRow's derivation.
  const agentStatus = trustedAgentStatus(session?.agent_status, conv.updated_at, now);
  const daemonAlive =
    agentStatus === "stopped"
      ? false
      : !!session?.last_heartbeat && now - session.last_heartbeat < HEARTBEAT_ALIVE_MS;
  const hasPending = !!conv.has_pending_messages;

  const lastMsg = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
    .order("desc")
    .first();

  const activity = deriveSessionActivity({
    agentStatus,
    agentStatusUpdatedAt: session?.agent_status_updated_at,
    lastMessageRole: lastMsg?.role ?? conv.last_message_role,
    lastMessagePreview: lastMsg?.content ?? conv.last_message_preview,
    hasPending,
    status: conv.status,
    updatedAt: conv.updated_at,
    daemonAlive,
    now,
  });
  let isIdle = activity.isIdle;

  // Open AskUserQuestion poll — same derivation as enrichInboxSessionRow: the
  // chronologically-latest message being the poll's tool_use means it is
  // unanswered (an answer would be a later tool_result), overriding the raced
  // agent_status.
  let awaitingInput = false;
  if (!isIdle && lastMsg?.role === "assistant" &&
      lastMsg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")) {
    awaitingInput = true;
    isIdle = true;
  }

  // An idle parent whose subagent child is still producing is WORKING on the
  // web (subagentKeepsParentWorking) — don't push mid-orchestration. Cheap
  // recent-output arm first; the child's managed session is read only when
  // that arm fails.
  if (isIdle && !awaitingInput) {
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conv._id))
      .take(20);
    for (const c of children) {
      if (!c.is_subagent || c.status !== "active") continue;
      if (subagentKeepsParentWorking({
        isSubagent: true, convStatus: c.status, updatedAt: c.updated_at,
        isLive: false, agentStatus: undefined, now,
      })) {
        isIdle = false;
        break;
      }
      const childSession = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", c._id))
        .first();
      const childAlive = !!childSession?.last_heartbeat && now - childSession.last_heartbeat < HEARTBEAT_ALIVE_MS;
      if (childAlive && subagentKeepsParentWorking({
        isSubagent: true, convStatus: c.status, updatedAt: c.updated_at,
        isLive: true, agentStatus: trustedAgentStatus(childSession?.agent_status, c.updated_at, now), now,
      })) {
        isIdle = false;
        break;
      }
    }
  }

  const state = classifyWorkState({
    agentStatus,
    isIdle,
    awaitingInput,
    hasPending,
    isUnresponsive: activity.isUnresponsive,
    messageCount: conv.message_count || 0,
  });
  if (state !== "needs_input") return { notified: false, reason: "not_needs_input" };

  const kind = needsInputKind({ awaitingInput, agentStatus, isUnresponsive: activity.isUnresponsive });
  // Dead/unresponsive sessions land in needs-input on the web too, but a push
  // for every deliberately closed terminal session is noise — keep the push to
  // the genuinely-waiting kinds.
  if (kind === "stopped" || kind === "unresponsive") return { notified: false, reason: "dead" };

  const key = `${conv.message_count}:${kind}`;
  if (conv.needs_input_notified_key === key) return { notified: false, reason: "dup" };

  // The daemon already pushes "Permission needed" when it creates the pending
  // permission record — only cover the recordless blocks (AskUserQuestion and
  // scraped prompts, which the daemon's SKIP_TOOLS deliberately skips).
  if (kind === "permission_blocked") {
    const open = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q: any) =>
        q.eq("conversation_id", conv._id).eq("status", "pending"),
      )
      .first();
    if (open) {
      await ctx.db.patch(conv._id, { needs_input_notified_key: key });
      return { notified: false, reason: "daemon_permission_push" };
    }
  }

  // Mark BEFORE delivering so a conflicting retry can't double-push.
  await ctx.db.patch(conv._id, { needs_input_notified_key: key });

  const title = conv.title?.trim() || conv.project_path?.split("/").pop() || "Session";
  const message =
    (kind === "awaiting_input" ? auqQuestionPreview(lastMsg) : null) ??
    (lastMsg?.role === "assistant" ? notifPreview(lastMsg.content) : null) ??
    conv.idle_summary ??
    "Waiting for your input";

  const delivered = await deliverSessionNotificationToParties(
    ctx, conv, "session_idle", title, message,
  );
  if (delivered) {
    await ctx.scheduler.runAfter(0, internal.idleSummary.generateIdleSummary, {
      conversation_id: conv._id,
    });
  }
  return { notified: delivered };
}

function notifPreview(text: string | undefined | null, max = 200): string | null {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

// The first question of an open AskUserQuestion poll — the most useful push
// body for "Claude is asking you something". tool_calls[].input is a JSON
// string (messages schema).
function auqQuestionPreview(lastMsg: any): string | null {
  const tc = lastMsg?.tool_calls?.find((t: any) => t.name === "AskUserQuestion");
  if (!tc) return null;
  try {
    const q = JSON.parse(tc.input)?.questions?.[0]?.question;
    return notifPreview(typeof q === "string" ? q : null);
  } catch {
    return null;
  }
}

export const checkNeedsInput = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    // agent_status_updated_at at scheduling time; the check aborts if the
    // status moved on since (a newer transition owns its own check).
    status_ts: v.optional(v.number()),
  },
  handler: (ctx, args) => performNeedsInputCheck(ctx, args),
});

const ENTITY_TYPE_VALIDATOR = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("plan"),
  v.literal("conversation")
);

export const isWatching = query({
  args: {
    entity_type: ENTITY_TYPE_VALIDATOR,
    entity_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.entity_id) return false;
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const sub = await ctx.db
      .query("entity_subscriptions")
      .withIndex("by_user_entity", (q: any) =>
        q.eq("user_id", userId).eq("entity_type", args.entity_type).eq("entity_id", args.entity_id)
      )
      .first();
    return sub ? !sub.muted : false;
  },
});

export const toggleWatch = mutation({
  args: {
    entity_type: ENTITY_TYPE_VALIDATOR,
    entity_id: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("entity_subscriptions")
      .withIndex("by_user_entity", (q: any) =>
        q.eq("user_id", userId).eq("entity_type", args.entity_type).eq("entity_id", args.entity_id)
      )
      .first();
    if (existing) {
      if (existing.reason === "watching") {
        await ctx.db.delete(existing._id);
        return { watching: false };
      }
      await ctx.db.patch(existing._id, { muted: !existing.muted });
      return { watching: existing.muted };
    }
    await ctx.db.insert("entity_subscriptions", {
      user_id: userId,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      reason: "watching",
      muted: false,
      created_at: Date.now(),
    });
    return { watching: true };
  },
});

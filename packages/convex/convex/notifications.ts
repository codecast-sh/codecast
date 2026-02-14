import { mutation, query, internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";

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

    for (const member of teamMembers) {
      if (
        member.push_token &&
        member.notifications_enabled &&
        member.notification_preferences?.team_session_start
      ) {
        await ctx.db.insert("notifications", {
          recipient_user_id: member._id,
          type: "team_session_start",
          actor_user_id: args.user_id,
          conversation_id: args.conversation_id,
          message: body,
          read: false,
          created_at: Date.now(),
        });

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
  },
});

export const create = mutation({
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
      v.literal("task_failed")
    ),
    actor_user_id: v.optional(v.id("users")),
    comment_id: v.optional(v.id("comments")),
    conversation_id: v.optional(v.id("conversations")),
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

    const notificationId = await ctx.db.insert("notifications", {
      recipient_user_id: args.recipient_user_id,
      type: args.type,
      actor_user_id: args.actor_user_id,
      comment_id: args.comment_id,
      conversation_id: args.conversation_id,
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

    const user = await ctx.db.get(auth.userId);
    if (!user) {
      return { error: "User not found" };
    }

    const prefs = user.notification_preferences;
    if (args.type === "session_idle" && prefs?.session_idle === false) {
      return { skipped: true };
    }
    if (args.type === "session_error" && prefs?.session_error === false) {
      return { skipped: true };
    }
    if (args.type === "permission_request" && prefs && !prefs.permission_request) {
      return { skipped: true };
    }

    const notificationId = await ctx.db.insert("notifications", {
      recipient_user_id: auth.userId,
      type: args.type,
      conversation_id: args.conversation_id,
      message: args.message,
      read: false,
      created_at: Date.now(),
    });

    if (user.push_token && user.notifications_enabled) {
      await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
        push_token: user.push_token,
        title: args.title,
        body: args.message,
        data: {
          conversationId: args.conversation_id,
          type: args.type,
        },
      });
    }

    return { notificationId };
  },
});

import { mutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

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

export const notifyTeamSessionStart = mutation({
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

    const teamMembers = await ctx.db
      .query("users")
      .filter((q) =>
        q.and(
          q.eq(q.field("team_id"), conversation.team_id),
          q.neq(q.field("_id"), args.user_id)
        )
      )
      .collect();

    for (const member of teamMembers) {
      if (
        member.push_token &&
        member.notifications_enabled &&
        member.notification_preferences?.team_session_start
      ) {
        await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
          push_token: member.push_token,
          title: 'New Team Session',
          body: `${user.name || user.email} started a new session`,
          data: {
            conversationId: args.conversation_id,
            type: 'team_session_start',
          },
        });
      }
    }
  },
});

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";


const ENTITY_TYPE = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("plan"),
  v.literal("conversation")
);

const NOTIFICATION_TYPE = v.union(
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
);

const PREFERENCE_MAP: Record<string, string> = {
  task_assigned: "task_activity",
  task_status_changed: "task_activity",
  task_commented: "task_activity",
  task_completed: "task_activity",
  task_failed: "task_activity",
  doc_updated: "doc_activity",
  doc_commented: "doc_activity",
  plan_status_changed: "plan_activity",
  plan_task_completed: "plan_activity",
  mention: "mention",
  comment_reply: "mention",
  conversation_comment: "mention",
  team_session_start: "team_session_start",
  permission_request: "permission_request",
  session_idle: "session_idle",
  session_error: "session_error",
};

function isNotificationEnabled(
  prefs: Record<string, any> | undefined,
  notificationType: string
): boolean {
  if (!prefs) return true;
  const prefKey = PREFERENCE_MAP[notificationType];
  if (!prefKey) return true;
  const val = prefs[prefKey];
  if (val === undefined) return true;
  return val !== false;
}

export const ensureSubscribed = internalMutation({
  args: {
    user_id: v.id("users"),
    entity_type: ENTITY_TYPE,
    entity_id: v.string(),
    reason: v.union(
      v.literal("creator"),
      v.literal("assignee"),
      v.literal("mentioned"),
      v.literal("commenter"),
      v.literal("watching")
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entity_subscriptions")
      .withIndex("by_user_entity", (q: any) =>
        q
          .eq("user_id", args.user_id)
          .eq("entity_type", args.entity_type)
          .eq("entity_id", args.entity_id)
      )
      .first();

    if (existing) return existing._id;

    return await ctx.db.insert("entity_subscriptions", {
      user_id: args.user_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      reason: args.reason,
      muted: false,
      created_at: Date.now(),
    });
  },
});

export const emit = internalMutation({
  args: {
    event_type: NOTIFICATION_TYPE,
    actor_user_id: v.id("users"),
    entity_type: ENTITY_TYPE,
    entity_id: v.string(),
    message: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    comment_id: v.optional(v.id("comments")),
    direct_recipient_id: v.optional(v.id("users")),
    actor_is_agent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actor = await ctx.db.get(args.actor_user_id);
    const actorName = actor?.name || actor?.github_username || "Someone";
    const skipSelfCheck = args.actor_is_agent === true;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const recipients: UserDoc[] = [];

    if (args.direct_recipient_id) {
      const u = await ctx.db.get(args.direct_recipient_id);
      if (u && (skipSelfCheck || u._id.toString() !== args.actor_user_id.toString())) {
        recipients.push(u);
      }
    } else {
      const subs = await ctx.db
        .query("entity_subscriptions")
        .withIndex("by_entity", (q: any) =>
          q
            .eq("entity_type", args.entity_type)
            .eq("entity_id", args.entity_id)
        )
        .collect();

      const seen = new Set<string>();
      for (const sub of subs) {
        if (sub.muted) continue;
        const uid = sub.user_id.toString();
        if ((!skipSelfCheck && uid === args.actor_user_id.toString()) || seen.has(uid)) continue;
        seen.add(uid);
        const u = await ctx.db.get(sub.user_id);
        if (u) recipients.push(u);
      }
    }

    let created = 0;

    for (const recipient of recipients) {
      if (
        !isNotificationEnabled(
          recipient.notification_preferences as any,
          args.event_type
        )
      ) {
        continue;
      }

      await ctx.db.insert("notifications", {
        recipient_user_id: recipient._id,
        type: args.event_type as any,
        actor_user_id: args.actor_user_id,
        entity_type: args.entity_type as any,
        entity_id: args.entity_id,
        conversation_id: args.conversation_id,
        comment_id: args.comment_id,
        message: args.message,
        read: false,
        created_at: now,
      });

      created++;

      if (recipient.push_token && recipient.notifications_enabled) {
        await ctx.scheduler.runAfter(
          0,
          internal.notifications.sendPushNotification,
          {
            push_token: recipient.push_token,
            title: actorName,
            body: args.message,
            data: {
              entity_type: args.entity_type,
              entity_id: args.entity_id,
              conversationId: args.conversation_id,
              type: args.event_type,
            },
          }
        );
      }
    }

    return { notified: created };
  },
});

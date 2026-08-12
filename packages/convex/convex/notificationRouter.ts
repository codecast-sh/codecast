import { internalMutation } from "./functions";
import { v } from "convex/values";
import { enqueuePush } from "./pushRouter";


const ENTITY_TYPE = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("plan"),
  v.literal("conversation"),
  v.literal("artifact"),
  v.literal("chat_channel")
);

const NOTIFICATION_TYPE = v.union(
  v.literal("mention"),
  v.literal("comment_reply"),
  v.literal("conversation_comment"),
  v.literal("team_invite"),
  v.literal("session_idle"),
  v.literal("permission_request"),
  v.literal("session_error"),
  v.literal("session_assigned"),
  v.literal("team_session_start"),
  v.literal("task_completed"),
  v.literal("task_failed"),
  v.literal("task_assigned"),
  v.literal("task_status_changed"),
  v.literal("task_commented"),
  v.literal("doc_updated"),
  v.literal("doc_commented"),
  v.literal("plan_status_changed"),
  v.literal("plan_task_completed"),
  v.literal("artifact_commented")
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
  artifact_commented: "artifact_activity",
  team_session_start: "team_session_start",
  permission_request: "permission_request",
  session_idle: "session_idle",
  session_error: "session_error",
  session_assigned: "session_assigned",
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
    // Absent for actors without an account (an anonymous artifact commenter);
    // actor_name/actor_avatar carry their display identity instead.
    actor_user_id: v.optional(v.id("users")),
    actor_name: v.optional(v.string()),
    actor_avatar: v.optional(v.string()),
    entity_type: ENTITY_TYPE,
    entity_id: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    comment_id: v.optional(v.id("comments")),
    direct_recipient_id: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actor = args.actor_user_id ? await ctx.db.get(args.actor_user_id) : null;
    const actorName = actor?.name || actor?.github_username || args.actor_name || "Someone";

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const recipients: UserDoc[] = [];

    const actorId = args.actor_user_id?.toString();
    if (args.direct_recipient_id) {
      const u = await ctx.db.get(args.direct_recipient_id);
      if (u && u._id.toString() !== actorId) {
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
        if (uid === actorId || seen.has(uid)) continue;
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

      const notifId = await ctx.db.insert("notifications", {
        recipient_user_id: recipient._id,
        type: args.event_type as any,
        actor_user_id: args.actor_user_id,
        actor_name: args.actor_name,
        actor_avatar: args.actor_avatar,
        entity_type: args.entity_type as any,
        entity_id: args.entity_id,
        link: args.link,
        conversation_id: args.conversation_id,
        comment_id: args.comment_id,
        message: args.message,
        read: false,
        created_at: now,
      });

      created++;

      if (recipient.push_token && recipient.notifications_enabled) {
        await enqueuePush(ctx, {
          user: recipient,
          notification_id: notifId,
          type: args.event_type,
          title: actorName,
          body: args.message,
          data: {
            entity_type: args.entity_type,
            entity_id: args.entity_id,
            conversationId: args.conversation_id,
            type: args.event_type,
            link: args.link,
          },
        });
      }
    }

    return { notified: created };
  },
});

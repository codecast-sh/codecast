import { internalMutation } from "./functions";
import { v } from "convex/values";
import { enqueuePush } from "./pushRouter";
import { isTeamMember } from "./privacy";

// The two unions live HERE and are imported wherever else a notification is
// written, so a new type cannot be added to one list and missed by the others.
export const ENTITY_TYPE = v.union(
  v.literal("task"),
  v.literal("doc"),
  v.literal("plan"),
  v.literal("conversation"),
  v.literal("artifact"),
  v.literal("chat_channel")
);

export const NOTIFICATION_TYPE = v.union(
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
  v.literal("artifact_commented"),
  v.literal("chat_mention"),
  v.literal("chat_reply"),
  v.literal("chat_here"),
  v.literal("chat_dm"),
  v.literal("chat_added"),
  // An ordinary channel line, emitted only to members whose per-channel notify
  // level is "all" (chat.ts gates it). For everyone else plain chatter stays
  // unread state with no row and no push.
  v.literal("chat_post")
);

export const PREFERENCE_MAP: Record<string, string> = {
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
  // A direct @you in chat is a mention like any other, so it rides the existing
  // key rather than inventing a second switch for the same idea. Thread replies
  // and @here are chat activity, which people mute separately.
  chat_mention: "mention",
  chat_reply: "chat_activity",
  chat_here: "chat_activity",
  // A DM is addressed to you by construction — same class as a mention.
  chat_dm: "mention",
  chat_added: "chat_activity",
  chat_post: "chat_activity",
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

// Who performed the act behind a subscription. See schema entity_subscriptions.via.
export const SUBSCRIPTION_VIA = v.union(v.literal("human"), v.literal("agent"));
export type SubscriptionVia = "human" | "agent";

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
    via: v.optional(SUBSCRIPTION_VIA),
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

    if (existing) {
      const patch: Record<string, unknown> = {};
      // A human act on a row an agent (or legacy write) enrolled upgrades it:
      // the person has now shown attention. Never downgrade human to agent.
      if (args.via === "human" && existing.via !== "human") patch.via = "human";
      // Re-engagement clears a mute (a handoff or an explicit unwatch): the
      // person's own human act, or attention directed AT them — an assignment
      // or a mention — whoever typed it. Agent acts never unmute.
      if (
        existing.muted &&
        (args.via === "human" || args.reason === "assignee" || args.reason === "mentioned")
      ) {
        patch.muted = false;
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("entity_subscriptions", {
      user_id: args.user_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      reason: args.reason,
      ...(args.via ? { via: args.via } : {}),
      muted: false,
      created_at: Date.now(),
    });
  },
});

// The durable "handed off / not following" marker on one (user, entity). A
// muted row grants no thread membership and no fan-out, whatever its reason,
// and it survives agent acts; only re-engagement (ensureSubscribed above) or
// an explicit unwatch clears it. Muting a person with no subscription row
// files one, so the marker exists to deny the identity legs (owner, assignee)
// that never read subscriptions to enroll.
export const setSubscriptionMuted = internalMutation({
  args: {
    user_id: v.id("users"),
    entity_type: ENTITY_TYPE,
    entity_id: v.string(),
    muted: v.boolean(),
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
    if (existing) {
      if (existing.muted !== args.muted) await ctx.db.patch(existing._id, { muted: args.muted });
      return existing._id;
    }
    if (!args.muted) return null;
    return await ctx.db.insert("entity_subscriptions", {
      user_id: args.user_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      reason: "watching",
      muted: true,
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
    // Chat deep link: entity_id already carries the channel, this names the exact
    // message. Both ride into the push payload so a tap lands on the message
    // rather than on the app.
    chat_message_id: v.optional(v.id("chat_messages")),
    chat_thread_root_id: v.optional(v.id("chat_messages")),
    direct_recipient_id: v.optional(v.id("users")),
    // The push banner's parts, when they differ from the bell row. The bell
    // keeps `message` (one full sentence); a phone banner reads like a
    // messaging app: title = who, subtitle = where, body = the words alone.
    push_subtitle: v.optional(v.string()),
    push_body: v.optional(v.string()),
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

    // A chat notification carries the message's own text in the bell and in the
    // phone banner, so who receives it is a privacy decision, not a routing one.
    // chat.ts already computes the recipient list and re-checks membership, but
    // this is the fan-out every future caller reaches for — and it does not
    // otherwise re-check anything — so the channel's own gate is applied here
    // too. A member removed from the team stops receiving the text immediately,
    // even if a stale subscription row outlives them.
    let allowed = recipients;
    if (args.entity_type === "chat_channel") {
      const channelId = ctx.db.normalizeId("chat_channels", args.entity_id);
      const channel = channelId ? await ctx.db.get(channelId) : null;
      if (!channel) return { notified: 0 };
      const members: typeof recipients = [];
      for (const recipient of recipients) {
        // The one membership check, from privacy.ts. A local copy of this query
        // is how a future rule (a hidden membership, a pending invite) gets
        // applied everywhere except the fan-out that ships message text.
        if (await isTeamMember(ctx, recipient._id, channel.team_id)) {
          members.push(recipient);
        }
      }
      allowed = members;
    }

    let created = 0;

    for (const recipient of allowed) {
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
        chat_message_id: args.chat_message_id,
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
          subtitle: args.push_subtitle,
          body: args.push_body ?? args.message,
          data: {
            entity_type: args.entity_type,
            entity_id: args.entity_id,
            conversationId: args.conversation_id,
            type: args.event_type,
            link: args.link,
            // Chat taps route on these ids: mobile opens /chat/<channelId>,
            // or the thread screen when threadRootId is present — a reply's
            // words live in the thread, so that is where the tap must land.
            channelId: args.entity_type === "chat_channel" ? args.entity_id : undefined,
            messageId: args.chat_message_id,
            threadRootId: args.chat_thread_root_id,
          },
        });
      }
    }

    return { notified: created };
  },
});

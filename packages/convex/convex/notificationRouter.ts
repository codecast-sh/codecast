import { internalMutation } from "./functions";
import type { MutationCtx } from "./_generated/server";
import { v, type ObjectType } from "convex/values";
import { enqueuePush } from "./pushRouter";
import { isTeamMember } from "./privacy";
import { ENTITY_TYPE, NOTIFICATION_TYPE } from "./lib/notificationTypes";

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
  // A frozen daemon delays deliveries and echoes, which is what session_error
  // already means to a reader. Riding that key keeps the alert under a mute
  // switch that exists rather than inventing one with no settings row.
  daemon_overloaded: "session_error",
  // The digest says the same thing its members say, so it rides the same
  // switch: muting "session idle" mutes the fold-up too.
  sessions_need_input: "session_idle",
  // The role is addressing the person by name about their own goals: the
  // same class as a mention, under the switch a person already has.
  goal_stall: "mention",
  // News about what the team can do, like a teammate starting a session.
  device_shared: "team_session_start",
  // The line's news about a cause is task news, under the switch a person
  // already has for their tasks.
  card_waiting: "task_activity",
  change_shipped: "task_activity",
  cause_reopened: "task_activity",
  // Someone acted on a question addressed to you by name: a mention's class.
  decision_answered_for_you: "mention",
  // Someone asking into your team (yours to decide), and being let into one:
  // both addressed to one person by name, the same class as a mention.
  team_join_request: "mention",
  team_join_approved: "mention",
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

const EMIT_ARGS = {
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
  // The caller already decided who this is news for (a task comment reaches
  // the same people its Threads row moves for). Skips the subscription scan.
  recipient_ids: v.optional(v.array(v.id("users"))),
  // The push banner's parts, when they differ from the bell row. The bell
  // keeps `message` (one full sentence); a phone banner reads like a
  // messaging app: title = who, subtitle = where, body = the words alone.
  push_subtitle: v.optional(v.string()),
  push_body: v.optional(v.string()),
  // false = bell row only, no phone push. A line a machine wrote in chat
  // rings the bell and never buzzes a pocket (agent-channels.md C3).
  push: v.optional(v.boolean()),
};

// The one fan-out. Callable inside a mutation's own transaction, so a
// caller with a plain ctx (sessionDecisions) notifies without a nested
// runMutation.
export async function emitNotification(ctx: MutationCtx, args: ObjectType<typeof EMIT_ARGS>) {
  const now = Date.now();
  const actor = args.actor_user_id ? await ctx.db.get(args.actor_user_id) : null;
  // A snapshot wins: Slack inbound names the person who posted, not the
  // workspace bridge the row is stored under. Same for a session-typed line.
  const actorName = args.actor_name || actor?.name || actor?.github_username || "Someone";

  type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
  const recipients: UserDoc[] = [];

  const actorId = args.actor_user_id?.toString();
  const named = args.recipient_ids ?? (args.direct_recipient_id ? [args.direct_recipient_id] : null);
  if (named) {
    const seen = new Set<string>();
    for (const id of named) {
      if (id.toString() === actorId || seen.has(id.toString())) continue;
      seen.add(id.toString());
      const u = await ctx.db.get(id);
      if (u) recipients.push(u);
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

    if (args.push !== false && recipient.push_token && recipient.notifications_enabled) {
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
}

export const emit = internalMutation({
  args: EMIT_ARGS,
  handler: (ctx, args) => emitNotification(ctx, args),
});

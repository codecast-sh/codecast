// Who a chat line notifies (chat.ts): the channel's audience, the people
// present right now, and the thread's participants.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { canAccessChannel, channelMemberIds, isRestricted } from "../chatAccess";
import { isSilentAgentRow, isThreadMuted } from "@codecast/shared/chat";
import { teamRoster } from "./mentionResolve";
import { isDesktopActivePresence } from "../pushRouter";
import { HERE_PRESENCE_MS, notifyLevelAllows } from "../chatText";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

// ── Notifications ───────────────────────────────────────────────────────────
//
// Chat never uses `emit`'s subscription fan-out. That fan-out re-checks nothing
// but the subscription row, and a chat notification carries the message's own
// text — so a stale subscription would keep delivering real content. The sender
// computes the recipient list here, re-checks team membership for each recipient
// at emit time, and emits one direct notification per person. `emit` re-applies
// the channel's gate on top (notificationRouter), and `purgeChatMembership`
// deletes the rows a departure leaves behind: three layers, because the failure
// here is a private message read by someone who was removed.
//
// A plain channel message produces a notification only for members who set the
// channel's notify level to "all" (chat_post — Slack's "All new posts"). For
// everyone else ordinary chatter is unread state only; anything louder by
// default trains people to ignore the badge.
export async function notifyChat(
  ctx: MutationCtx,
  opts: {
    eventType: "chat_mention" | "chat_reply" | "chat_here" | "chat_dm" | "chat_added" | "chat_post";
    actorUserId: Id<"users">;
    actorName: string;
    channel: Doc<"chat_channels">;
    messageId?: Id<"chat_messages">;
    // The thread the message lives in, when it is a reply. Rides the push
    // payload so a phone tap can land IN the thread, where the words are.
    threadRootId?: Id<"chat_messages">;
    recipientId: Id<"users">;
    message: string;
    // The phone banner's parts. `message` stays the bell's full sentence;
    // the banner reads like a messaging app — title (actor) is added by the
    // router, subtitle says where, body is the words alone.
    pushSubtitle?: string;
    pushBody?: string;
    /** A line a machine wrote (a bot author, or origin "agent"): the bell rings,
     *  the phone stays quiet (agent-channels.md C3). */
    agentLine?: boolean;
    /** Face to store on the row when it is not the actor user's own — a Slack
     *  person speaking through the workspace bridge, a session-typed line. */
    actorAvatar?: string;
  },
): Promise<void> {
  if (opts.recipientId.toString() === opts.actorUserId.toString()) return;
  const recipient = await ctx.db.get(opts.recipientId);
  // Bots have no bell and no phone; waking one is the anchor path, not this one.
  if (!recipient || recipient.is_bot) return;
  // The full access check, not just team membership: a @mention of someone
  // outside a private room must never deliver words they cannot read.
  if (!(await canAccessChannel(ctx, opts.recipientId, opts.channel))) return;
  // The per-channel mute, applied where the notification is WRITTEN. Storing a
  // level and honouring it only in the client's toast would leave the bell and
  // the phone loud, which is the one place a mute has to work: a muted channel
  // must not buzz a pocket.
  const read = await ctx.db
    .query("chat_reads")
    .withIndex("by_user_channel", (q: any) =>
      q.eq("user_id", opts.recipientId).eq("channel_id", opts.channel._id))
    .first();
  // No row means the member has never opened this channel, which reads as
  // "mentions only" — the same default the rail shows.
  if (!notifyLevelAllows(read?.notify_level ?? "mentions", opts.eventType)) return;
  // A thread the member muted keeps its replies quiet; a mention still lands.
  if (opts.eventType === "chat_reply" && isThreadMuted(read?.muted_threads, opts.threadRootId)) return;
  await ctx.runMutation(internal.notificationRouter.emit, {
    event_type: opts.eventType,
    actor_user_id: opts.actorUserId,
    actor_name: opts.actorName,
    actor_avatar: opts.actorAvatar,
    entity_type: "chat_channel",
    entity_id: opts.channel._id.toString(),
    message: opts.message,
    chat_message_id: opts.messageId,
    chat_thread_root_id: opts.threadRootId,
    direct_recipient_id: opts.recipientId,
    push_subtitle: opts.pushSubtitle,
    push_body: opts.pushBody,
    push: opts.agentLine ? false : undefined,
  });
}

// Everyone who has spoken in a thread: its root author plus every reply author.
// This is the thread's notification audience AND its participant faces, derived
// rather than denormalized onto the root row — so a tombstoned reply cannot
// leave a stale count behind and a reply never re-versions the fattest document
// in the table.
export async function threadParticipants(
  ctx: ReadCtx,
  root: Doc<"chat_messages">,
  limit = 200,
): Promise<Id<"users">[]> {
  const replies = await ctx.db
    .query("chat_messages")
    .withIndex("by_thread_created", (q: any) => q.eq("thread_root_id", root._id))
    .order("desc")
    .take(limit);
  const ids: Id<"users">[] = [];
  const seen = new Set<string>();
  for (const row of [root, ...replies]) {
    if (row.deleted_at || isSilentAgentRow(row)) continue;
    const key = row.user_id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(row.user_id);
  }
  return ids;
}

// Everyone a channel's messages are FOR: the team roster, narrowed to the
// room's members when the room is restricted, bots excluded. The audience for
// @here and for chat_post — one definition so the two can never disagree.
export async function channelAudience(
  ctx: ReadCtx,
  channel: Doc<"chat_channels">,
): Promise<Id<"users">[]> {
  let roster = await teamRoster(ctx, channel.team_id);
  if (isRestricted(channel)) {
    const members = new Set((await channelMemberIds(ctx, channel._id)).map(String));
    roster = roster.filter((u) => members.has(u._id.toString()));
  }
  return roster.filter((u) => !u.is_bot).map((u) => u._id);
}

// The members who are actually AT a keyboard right now, for @here. Presence is
// the same signal push routing uses, so "here" means the same thing everywhere.
// In a private room "here" reaches the room's members, never the whole team.
export async function presentMembers(
  ctx: ReadCtx,
  channel: Doc<"chat_channels">,
  now: number,
): Promise<Id<"users">[]> {
  const present: Id<"users">[] = [];
  for (const userId of await channelAudience(ctx, channel)) {
    const presence = await ctx.db
      .query("user_presence")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId))
      .first();
    if (!presence) continue;
    if (
      isDesktopActivePresence(presence, now)
      || now - presence.last_input_at < HERE_PRESENCE_MS
    ) {
      present.push(userId);
    }
  }
  return present;
}

// A person's read state in chat (chat.ts): the channel read row and the
// per-thread read rows the Threads inbox counts from.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isLiveVoiceRow, isSilentAgentRow } from "@codecast/shared/chat";
import { touchThread } from "../threadReads";
import { UNREAD_CAP } from "../chatText";
import { patchChat } from "./chatRows";
import { threadParticipants } from "./chatNotify";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

// ── Read state ──────────────────────────────────────────────────────────────

// The caller's own row, always. `user_id` is never an argument: one would let
// anyone clear a teammate's badge or silently mute them.
export async function upsertRead(
  ctx: MutationCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
  channelId: Id<"chat_channels">,
  readAt: number,
  lastMessageId: Id<"chat_messages"> | undefined,
  notifyLevel: "all" | "mentions" | "none" | undefined,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("chat_reads")
    .withIndex("by_user_channel", (q: any) =>
      q.eq("user_id", userId).eq("channel_id", channelId))
    .first();
  if (!existing) {
    await ctx.db.insert("chat_reads", {
      user_id: userId,
      channel_id: channelId,
      team_id: teamId,
      last_read_at: readAt,
      last_read_message_id: lastMessageId,
      // Slack's default: a joined channel notifies for what is addressed to you
      // (mentions, @here, your threads, DMs) and badges the rest. "all" is the
      // per-channel opt-in, never the starting point.
      notify_level: notifyLevel ?? "mentions",
      joined_at: now,
      updated_at: now,
    });
    return;
  }
  const patch: Record<string, unknown> = {};
  // A read mark only ever moves forward: an out-of-order client write must not
  // resurrect messages the user has already seen.
  if (readAt > existing.last_read_at) {
    patch.last_read_at = readAt;
    patch.last_read_message_id = lastMessageId ?? existing.last_read_message_id;
  }
  if (notifyLevel && notifyLevel !== existing.notify_level) patch.notify_level = notifyLevel;
  if (!existing.joined_at) patch.joined_at = now;
  if (Object.keys(patch).length === 0) return;
  await patchChat(ctx, existing._id, patch);
}

// ── Thread read state ───────────────────────────────────────────────────────
//
// The rows behind the Threads inbox live in thread_reads (threadReads.ts),
// one per (participant, thread root). They are written from exactly the two
// places a VISIBLE reply lands — the shared insert path and the anchor's
// landed answer — so a thread appears in someone's inbox precisely when a
// chat_reply notification could have reached them, and a silent listening row
// or an in-flight placeholder never raises a badge. The inbox itself
// (threads.listMine, unreadCount, markRead, markAllRead) lives in threads.ts.

/** Replies to scan when counting one thread's unread. Shares the channel
 *  badge's cap so "50+" means the same thing on both surfaces. */
export const THREAD_UNREAD_SCAN = UNREAD_CAP + 5;

export async function touchThreadReads(
  ctx: MutationCtx,
  opts: {
    channel: Doc<"chat_channels">;
    root: Doc<"chat_messages">;
    /** The landing reply's stamp — becomes every participant's activity mark. */
    activityAt: number;
    /** The reply's author: their own row reads as read (they have obviously
     *  seen the thread they just wrote into). A bot author is skipped like
     *  every other bot. */
    actorId?: Id<"users">;
    /** People this reply mentioned: being named in a thread starts following
     *  it, even before you have spoken in it. */
    extraParticipants?: Id<"users">[];
  },
): Promise<void> {
  await touchThread(ctx, {
    kind: "chat",
    rootKey: String(opts.root._id),
    teamId: opts.channel.team_id,
    refs: { channel_id: opts.channel._id },
    participants: [...(await threadParticipants(ctx, opts.root)), ...(opts.extraParticipants ?? [])],
    actorId: opts.actorId,
    activityAt: opts.activityAt,
  });
}

/** One thread's unread, by the channel badge's own counting rules. */
export async function threadUnreadFor(
  ctx: ReadCtx,
  userId: Id<"users">,
  rootId: Id<"chat_messages">,
  lastReadAt: number,
): Promise<{ unread: number; unread_capped: boolean }> {
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_thread_created", (q: any) =>
      q.eq("thread_root_id", rootId).gt("created_at", lastReadAt))
    .take(THREAD_UNREAD_SCAN);
  const counted = rows.filter(
    (r) => !r.deleted_at && !isSilentAgentRow(r) && !isLiveVoiceRow(r)
      && r.user_id.toString() !== userId.toString(),
  ).length;
  return { unread: Math.min(counted, UNREAD_CAP), unread_capped: counted > UNREAD_CAP };
}

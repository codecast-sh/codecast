// Typing presence for team chat.
//
// Split from chat.ts on purpose: typing is ephemeral presence, not chat state.
// Nothing here goes through the store sync pipeline or the outbox — the client
// subscribes directly while a channel is on screen and lets rows age out.
//
// The freshness contract has two halves. The server filters LIST to rows
// touched in the last TYPING_STALE_MS, but a Convex query only re-runs on a
// data change — time passing alone never re-evaluates it. So the client owns
// the countdown: it hides rows older than its own (shorter) TTL on a local
// ticker. A row leaked by a closed tab therefore shows for a few seconds at
// most, and only to people already looking at the channel.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { loadChannel, requireCaller } from "./chat";

/** LIST ignores rows older than this. Generous on purpose — the client's own
 *  TTL (chatTyping client hook) is the one that decides visibility; this
 *  bound only keeps long-dead rows out of the payload. */
export const TYPING_STALE_MS = 15_000;

/** SET refreshed within this window is a no-op, so a client that misfires
 *  faster than its own throttle cannot churn every subscriber's query. */
const MIN_REFRESH_MS = 1_000;

const threadKey = (threadRootId: string | undefined): string => threadRootId ?? "";

async function ownRow(
  ctx: { db: any },
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("chat_typing")
    .withIndex("by_channel_user", (q: any) =>
      q.eq("channel_id", channelId).eq("user_id", userId))
    .first();
}

// Refresh the caller's "typing here" stamp. Upsert, never insert-beside: one
// row per (channel, user), whose thread_key simply follows the box they are in.
export const set = mutation({
  args: {
    api_token: v.optional(v.string()),
    channel_id: v.id("chat_channels"),
    thread_root_id: v.optional(v.id("chat_messages")),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const channel = await loadChannel(ctx, userId, args.channel_id);
    const now = Date.now();
    const key = threadKey(args.thread_root_id);
    const existing = await ownRow(ctx, channel._id, userId);
    if (existing) {
      if (existing.thread_key === key && now - existing.updated_at < MIN_REFRESH_MS) return;
      await ctx.db.patch(existing._id, { thread_key: key, updated_at: now });
      return;
    }
    await ctx.db.insert("chat_typing", {
      channel_id: channel._id,
      user_id: userId,
      thread_key: key,
      updated_at: now,
    });
  },
});

// The caller stopped typing (sent, cleared the box, left the surface). Delete
// rather than stamp-stale: the disappearance is what re-runs subscribers, so
// the indicator drops the moment the message lands instead of one TTL later.
export const clear = mutation({
  args: {
    api_token: v.optional(v.string()),
    channel_id: v.id("chat_channels"),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    // No loadChannel: deleting your own presence row must work even from a
    // channel you just lost access to, and the row is keyed by the caller.
    const existing = await ownRow(ctx, args.channel_id, userId);
    if (existing) await ctx.db.delete(existing._id);
  },
});

// Everyone typing in this channel — both the floor and every open thread, in
// one subscription, so the page and its thread panel share a single query.
// The caller's own row is included; the client filters self (auth-dependent
// results would split Convex's per-args cache for no gain).
export const list = query({
  args: {
    api_token: v.optional(v.string()),
    channel_id: v.id("chat_channels"),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const channel = await loadChannel(ctx, userId, args.channel_id);
    const cutoff = Date.now() - TYPING_STALE_MS;
    const rows = await ctx.db
      .query("chat_typing")
      .withIndex("by_channel_updated", (q: any) =>
        q.eq("channel_id", channel._id).gt("updated_at", cutoff))
      .collect();
    return rows.map((r: any) => ({
      user_id: r.user_id,
      thread_key: r.thread_key,
      updated_at: r.updated_at,
    }));
  },
});

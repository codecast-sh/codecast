// Live replies: the reply Claude Code is writing right now, one reused row per
// conversation. The daemon pushes the text so far as its MessageDisplay hook
// hands over each finished line; the web draws it after the last message and
// hides it once the real message lands. The contract, and why the hand-off is
// derived on the web rather than written here, is in
// @codecast/shared/contracts/replyStream.
//
// COST. A push writes only while someone has the conversation open and the
// feature is on, into a row with one writer, and never touches the
// conversation document or `messages`, so a streaming reply re-runs only the
// queries that read this row.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query, mutation, internalMutation } from "./functions";
import { requireUserOrToken } from "./lib/auth";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";
import { checkConversationAccess } from "./privacy";
import { PRESENCE_FRESH_MS } from "./presencePolicy";
import { redactSecrets } from "./redact";
import {
  REPLY_STREAM_LOAD_MAX_AGE_MS,
  REPLY_STREAM_MAX_CHARS,
  type ReplyStreamPushResult,
  type ReplyStreamRow,
} from "@codecast/shared/contracts";

const PRUNE_AFTER_MS = 60 * 60 * 1000;

// A key block still being written: redaction needs its END line, which the
// stream has not reached. The text stops before the block until it closes
// and redacts whole, as it will in the message.
const OPEN_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*KEY-----(?![\s\S]*-----END [A-Z0-9 ]*KEY-----)[\s\S]*$/;

/** The daemon's push of one reply's text so far. Answers whether it was
 *  written, so the daemon can stop pushing to a conversation nobody watches
 *  or whose workspace has the feature off. */
export const push = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.id("conversations"),
    message_id: v.string(),
    seq: v.number(),
    started_at: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<ReplyStreamPushResult> => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) throw new Error("Conversation not found");
    if (conv.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only stream replies to your own conversations");
    }

    // team_id here routes the flag lookup to the conversation's team; it
    // grants nothing (access was the ownership check above).
    if (!(await workspaceHasFeature(ctx, { team_id: conv.team_id, user_id: conv.user_id }, "reply_streaming"))) {
      return { state: "off" };
    }

    const now = Date.now();
    // A closed tab never clears its presence row, so the range is everyone
    // whose last view was this conversation: capped, like attendingOwner's.
    const viewers = await ctx.db
      .query("user_presence")
      .withIndex("by_viewing_conversation", (q) => q.eq("viewing_conversation_id", args.conversation_id))
      .take(50);
    if (!viewers.some((p) => now - p.last_seen < PRESENCE_FRESH_MS)) return { state: "unwatched" };

    const row = await ctx.db
      .query("reply_streams")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    // A late or reordered push: an older line of this message, or an older
    // message. Only a row still being written orders anything: started_at is
    // the pushing machine's clock, and a session that moved to a machine
    // whose clock runs behind must not be shut out by the row it left.
    const live = row && now - row.updated_at <= REPLY_STREAM_LOAD_MAX_AGE_MS;
    if (live && ((row.message_id === args.message_id && args.seq <= row.seq) || args.started_at < row.started_at)) {
      return { state: "written" };
    }

    // The same last pass addMessages gives a message, so the row never holds
    // what the message would not, and the stream still opens the message that
    // hands it off.
    let text = args.text.slice(0, REPLY_STREAM_MAX_CHARS);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = redactSecrets(text).replace(OPEN_KEY_BLOCK, "");
    const fields = { message_id: args.message_id, text, seq: args.seq, started_at: args.started_at, updated_at: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("reply_streams", { conversation_id: args.conversation_id, user_id: userId, ...fields });
    return { state: "written" };
  },
});

/** The reply being written in a conversation, for whoever may read its
 *  messages. Reads the row first, so a quiet conversation costs its viewers
 *  one empty index range and no conversation read. */
export const get = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<ReplyStreamRow | null> => {
    const row = await ctx.db
      .query("reply_streams")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    // Before the conversation is read: a finished reply's row then depends on
    // nothing a busy conversation keeps changing.
    if (!row || Date.now() - row.updated_at > REPLY_STREAM_LOAD_MAX_AGE_MS) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    // listMessagesTail's rule: a teammate holding only Summary access is "denied".
    if ((await checkConversationAccess(ctx, await getAuthUserId(ctx), conv)) === "denied") return null;
    return {
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      text: row.text,
      seq: row.seq,
      started_at: row.started_at,
      updated_at: row.updated_at,
    };
  },
});

/** Drop rows no push has touched for an hour (crons.ts). The web stops
 *  drawing a row long before that; the next reply recreates it. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const rows = await ctx.db
      .query("reply_streams")
      .withIndex("by_updated_at", (q) => q.lt("updated_at", cutoff))
      .take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});

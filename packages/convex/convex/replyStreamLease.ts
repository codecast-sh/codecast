// Live replies: the lease a reply's pushes are written under (replyStreams).
// A page showing a conversation takes it and renews it about once a minute
// while the conversation is on screen (the web's useSyncReplyStream), so the
// daemon's pushes are written only for conversations someone is looking at.
// Presence could not answer that: it keeps one viewed conversation per person,
// and every other window they have open overwrites it.
//
// A module of its own because it writes nothing a reader of the stream can
// see: `replyStreams.get` answers the same before and after a renewal.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./functions";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";
import { checkConversationAccess } from "./privacy";
import { REPLY_STREAM_WATCH_MS } from "@codecast/shared/contracts";

/** A renewal is written only when the lease has this much less left than a
 *  fresh one, so several windows renewing in the same half minute cost one
 *  write. */
const WATCH_WRITE_EVERY_MS = 30_000;

/** "This conversation is on screen." Creates the conversation's stream row,
 *  empty, when there is none. Any number of windows and people may hold the
 *  lease; it only ever extends. Does nothing, and says nothing, for a caller
 *  who may not read the conversation's messages or a workspace with the
 *  feature off. */
export const watch = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    // Whoever may read the conversation's messages may watch it (replyStreams.get's rule).
    if (!conv || (await checkConversationAccess(ctx, userId, conv)) === "denied") return null;
    if (!(await workspaceHasFeature(ctx, { team_id: conv.team_id, user_id: conv.user_id }, "reply_streaming"))) return null;
    const now = Date.now();
    const until = now + REPLY_STREAM_WATCH_MS;
    const row = await ctx.db
      .query("reply_streams")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .first();
    if (!row) {
      await ctx.db.insert("reply_streams", {
        conversation_id: args.conversation_id, user_id: conv.user_id,
        message_id: "", text: "", seq: 0, started_at: 0, updated_at: now, watch_until: until,
      });
    } else if ((row.watch_until ?? 0) < until - WATCH_WRITE_EVERY_MS) {
      await ctx.db.patch(row._id, { watch_until: until });
    }
    return null;
  },
});

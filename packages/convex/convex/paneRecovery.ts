import { v } from "convex/values";
import { mutation } from "./functions";
import { enqueueKillAndResume } from "./conversations";
import { enqueuePendingMessage, getAuthenticatedUserId, notifyStuckSend, patchPendingMessageStatus, senderOrOwnerCanAct } from "./pendingMessages";
import { noteWriteCause } from "./lifecycleEvents";
import { PANE_REFUSED_ERROR, planPaneRefusal } from "./lib/paneRefusal";

// The daemon's report that a pane refused a message; lib/paneRefusal.ts says why and what follows.

export const reportPaneRefused = mutation({
  args: { message_id: v.id("pending_messages"), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ recovered: boolean }> => {
    noteWriteCause(ctx, "reportPaneRefused");
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const msg = await ctx.db.get(args.message_id);
    if (!msg) return { recovered: false };
    if (!(await senderOrOwnerCanAct(ctx, msg, userId))) throw new Error("Unauthorized: can only report messages you sent or own");
    const conv = await ctx.db.get(msg.conversation_id);
    await patchPendingMessageStatus(ctx, msg, { status: "cancelled" });
    if (!conv) return { recovered: false };
    const now = Date.now();
    const plan = planPaneRefusal(conv as any, now);
    if (plan.kind === "recover") {
      await ctx.db.patch(conv._id, { pane_recovered_at: now });
      await enqueueKillAndResume(ctx, conv.user_id, conv as any, { cause: "pane_refused_input" });
      await enqueuePendingMessage(ctx, conv, msg.from_user_id, {
        content: msg.content,
        ...(msg.image_storage_id ? { image_storage_id: msg.image_storage_id } : {}),
        ...(msg.image_storage_ids ? { image_storage_ids: msg.image_storage_ids } : {}),
        ...(msg.from_conversation_id ? { from_conversation_id: msg.from_conversation_id } : {}),
        ...(msg.origin ? { origin: msg.origin } : {}),
        ...(msg.human ? { human: true } : {}),
      });
      return { recovered: true };
    }
    if (plan.markError) {
      await ctx.db.patch(conv._id, { pane_refused_at: now, ...(conv.session_error ? {} : { session_error: PANE_REFUSED_ERROR }), updated_at: now });
    }
    if (msg.from_conversation_id && msg.from_conversation_id !== conv._id && !msg.sender_notified_at) {
      await notifyStuckSend(ctx, msg, "refused");
    }
    return { recovered: false };
  },
});

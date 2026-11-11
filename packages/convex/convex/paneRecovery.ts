import { v } from "convex/values";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { enqueueKillAndResume } from "./conversations";
import { enqueuePendingMessage, getAuthenticatedUserId, notifyStuckSend, patchPendingMessageStatus, senderOrOwnerCanAct } from "./pendingMessages";
import { noteWriteCause } from "./lifecycleEvents";

// A daemon wrote a message into a session's terminal TMUX_PASTE_WRITE_CAP
// times, it never appeared at the prompt, and no write got an Enter: the
// agent provably never had it. The pane is deaf (a wedged TUI, a machine too
// loaded to draw the paste before the check gives up). On 2026-11-11 the
// Union roles on a laptop at load 170-200 went deaf this way and stayed deaf:
// each message was cancelled, its notice landed in the deaf session itself,
// and its sender was told it "stays queued".
//
// An unattended seat (a role's standing session, a workspace anchor) has no
// person watching its pane, so it recovers itself: one restart in a fresh
// pane and the message sent again as a new row (a fresh write budget; never
// a duplicate, since nothing was submitted). At most once per window, so a
// pane that stays deaf after a restart is not restarted in a loop: the next
// refusal marks the session's error and tells the sender instead.
export const PANE_RECOVERY_WINDOW_MS = 30 * 60_000;

export const PANE_REFUSED_ERROR = "Its terminal is not taking input, and a restart did not fix it. Its machine may be overloaded: move it to another machine.";

export type PaneRefusalPlan = { kind: "recover" } | { kind: "give_up"; markError: boolean };

export function planPaneRefusal(
  conv: { standing_role_id?: unknown; anchor_id?: unknown; inbox_killed_at?: number; pane_recovered_at?: number },
  now: number,
): PaneRefusalPlan {
  const unattended = !!(conv.standing_role_id || conv.anchor_id);
  if (!unattended || conv.inbox_killed_at) return { kind: "give_up", markError: false };
  if (conv.pane_recovered_at && now - conv.pane_recovered_at < PANE_RECOVERY_WINDOW_MS) return { kind: "give_up", markError: true };
  return { kind: "recover" };
}

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

// The pane took a message again: whatever error the refusal wrote is no longer true.
export async function clearPaneRefused(ctx: { db: any }, conversationId: Id<"conversations">): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv?.pane_refused_at) return;
  await ctx.db.patch(conversationId, {
    pane_refused_at: undefined,
    ...(conv.session_error === PANE_REFUSED_ERROR ? { session_error: undefined } : {}),
  });
}

import { MID_TURN_AGENT_STATUSES, MOVE_INTERRUPT_MESSAGE, moveContinueClientId } from "@codecast/shared/contracts";
import type { Id } from "./_generated/dataModel";
import { enqueuePendingMessage } from "./pendingMessages";

/**
 * A move stops the agent's process on the machine it leaves, so a turn in
 * progress there ends partway, and the resume on the new machine writes no
 * prompt the model answers: the session sat stopped with the person's messages
 * unanswered until someone typed "continue" (jx74yqy and jx7d538, 2026-10-23).
 * So the move queues the continue itself. Call it after the conversation is
 * re-homed (delivery follows the new owner) and before the managed rows that
 * say a turn was running are released or dropped.
 */
export async function queueMoveContinueIfMidTurn(ctx: any, conversationId: Id<"conversations">, fromUserId: Id<"users">): Promise<void> {
  const managed = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  if (!managed.some((row: any) => MID_TURN_AGENT_STATUSES.has(row.agent_status ?? ""))) return;
  // A second move before the first resumed still reads the turn as running;
  // one continue, delivered wherever the session lands, is enough.
  for (const status of ["pending", "held"]) {
    const waiting = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", status))
      .collect();
    if (waiting.some((row: any) => row.content === MOVE_INTERRUPT_MESSAGE)) return;
  }
  const conv = await ctx.db.get(conversationId);
  if (!conv) return;
  await enqueuePendingMessage(ctx, conv, fromUserId, {
    content: MOVE_INTERRUPT_MESSAGE,
    client_id: moveContinueClientId(String(conversationId), Date.now()),
  });
}

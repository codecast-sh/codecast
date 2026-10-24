// Server half of the shared send outcome (shared/comments/sendOutcome.ts):
// whether a message just queued for a session will be read now or waits.
import { HEARTBEAT_ALIVE_MS, MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";
import type { SendWaiting } from "@codecast/shared/comments";
import type { Id } from "../_generated/dataModel";

/**
 * "busy" when the session is mid-turn (the message is read when the turn
 * ends), "offline" when no process has beaten its heartbeat (read when it is
 * back), null when an idle live session takes it now.
 */
export async function sessionWaiting(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  now = Date.now(),
): Promise<SendWaiting | null> {
  const sessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  const live = sessions.filter((s: any) => now - (s.last_heartbeat ?? 0) < HEARTBEAT_ALIVE_MS);
  if (live.length === 0) return "offline";
  return live.some((s: any) => s.agent_status && MID_TURN_AGENT_STATUSES.has(s.agent_status)) ? "busy" : null;
}

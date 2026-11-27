// Whether a session has settled: ended its turn with nothing of its own still
// to wake it. A leaf, so the parked-wake recompute (beneath every wrapped
// mutation) can read it as well as the worker report and the waits on a
// session (workerSettle.ts, lib/waitingOn.ts).

import type { Doc } from "../_generated/dataModel";
import { ACTIVE_AGENT_STATUSES, threadStateFreshness } from "@codecast/shared/contracts";

type SettleRow = Pick<Doc<"conversations">, "thread_state" | "thread_state_status" | "thread_state_at" | "thread_state_msg_count" | "message_count">;

/** What the session settled on (a WORKER_SETTLE_WORDS key); null while it is
 *  still its own business (producing, or parked on a wake of its own). The
 *  daemon re-derives dormant, done and waiting from the declaration at every
 *  turn end, so the status alone decides; the pinned line only words a plain
 *  settle. */
export function workerSettleWhy(w: Partial<SettleRow>, agentStatus: string | undefined, now: number): string | null {
  if (!agentStatus || ACTIVE_AGENT_STATUSES.has(agentStatus)) return null;
  if (agentStatus === "dormant" || agentStatus === "waiting") return null;
  if (agentStatus === "stopped" || agentStatus === "permission_blocked" || agentStatus === "done") return agentStatus;
  const blocked = w.thread_state_status === "blocked" && !!w.thread_state &&
    threadStateFreshness(w, w.message_count ?? 0, now).freshness !== "stale";
  return blocked ? "blocked" : "ended";
}

/** Work handed to a settled session that it has not taken up yet: a message
 *  still queued for it, or one that arrived after its last settle. It is not
 *  settled while that stands (`cast send jxB "do X"` then waiting on jxB). */
export function hasUnreadWork(conv: Pick<Doc<"conversations">, "has_pending_messages" | "last_user_message_at">, settledAt: number | undefined): boolean {
  return !!conv.has_pending_messages || (!!conv.last_user_message_at && !!settledAt && conv.last_user_message_at > settledAt);
}

/** workerSettleWhy over the session's own daemon status; a killed session has
 *  stopped, and one with unread work has not settled. */
export async function sessionSettledWhy(ctx: { db: any }, conv: Doc<"conversations">, now: number): Promise<string | null> {
  if (conv.inbox_killed_at) return "stopped";
  const session = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first();
  const why = workerSettleWhy(conv, session?.agent_status, now);
  return why && hasUnreadWork(conv, session?.agent_status_updated_at) ? null : why;
}

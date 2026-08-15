// The one way to read "this user's live managed sessions".
//
// managed_sessions is heartbeat-hot: every live session rewrites its row every
// ~45s, and Convex keeps ~10 days of old index versions, so any index range
// that covers a row's history wades through a tombstone graveyard (see the
// reapStaleManagedSessions comment in managedSessions.ts). An unbounded
// `by_user_id` collect therefore times out with "too many system operations"
// even though the current row count is small — which is what took down
// tasks.webActiveSessions. Seeking `by_user_heartbeat` with a lower bound
// lands in the recent sliver past the graveyard: tombstones carry OLD
// heartbeat values, so they sort outside the window.
//
// Callers that need dead-but-recent rows too (e.g. the inbox's status maps)
// are a different read and must not funnel through this.

import type { Doc, Id } from "../_generated/dataModel";
import { HEARTBEAT_ALIVE_MS } from "../inboxFilters";

export async function listLiveManagedSessions(
  ctx: { db: any },
  userId: Id<"users">,
  opts?: { now?: number; aliveMs?: number },
): Promise<Doc<"managed_sessions">[]> {
  const now = opts?.now ?? Date.now();
  const aliveMs = opts?.aliveMs ?? HEARTBEAT_ALIVE_MS;
  return ctx.db
    .query("managed_sessions")
    .withIndex("by_user_heartbeat", (q: any) =>
      q.eq("user_id", userId).gt("last_heartbeat", now - aliveMs),
    )
    .collect();
}

// Conversation ids of the user's live sessions — the shape most call sites
// actually want (rows without a conversation_id are unlinked daemons).
export async function liveConversationIdSet(
  ctx: { db: any },
  userId: Id<"users">,
  opts?: { now?: number; aliveMs?: number },
): Promise<Set<string>> {
  const sessions = await listLiveManagedSessions(ctx, userId, opts);
  return new Set(
    sessions.filter((s) => s.conversation_id).map((s) => s.conversation_id!.toString()),
  );
}

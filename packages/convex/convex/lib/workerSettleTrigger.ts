// The settle half managedSessions calls on every status report: is this a
// spawned worker, and if so schedule workerSettle.tellParent one idle grace
// later. Kept apart from workerSettle.ts so the status path does not import
// the fleet drain and the whole function graph behind it (ct-92329).
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { NEEDS_INPUT_IDLE_CHECK_DELAY_MS } from "../inboxFilters";

export type WorkerRow = {
  _id: Id<"conversations">;
  user_id: Id<"users">;
  parent_conversation_id?: Id<"conversations">;
  is_subagent?: boolean;
  is_workflow_sub?: boolean;
  agent_task_id?: unknown;
  org_role_id?: unknown;
  standing_role_id?: unknown;
  agent_team_name?: string;
  message_count?: number;
  // The hide stamps a machine report reads to leave a closed worker alone (shared isClosedSession).
  inbox_dismissed_at?: number;
  inbox_closed_at?: number;
  inbox_killed_at?: number;
  short_id?: string;
  title?: string;
  thread_state?: string;
  thread_state_status?: string;
  thread_state_at?: number;
  thread_state_msg_count?: number;
  hand_wake_notified_key?: string;
  reported_to_parent_at?: number;
};

// A role's hand is a worker like any other: it reports to the session that
// started it, which is woken when it settles (createSessionFromCli nests every
// hand under its spawner). A role's standing session never is one.
export function isSpawnedWorker(c: WorkerRow): boolean {
  return c.is_subagent === true && !!c.parent_conversation_id && !c.agent_task_id && !c.is_workflow_sub &&
    !c.standing_role_id && !c.agent_team_name;
}

export async function scheduleWorkerSettle(ctx: any, conversationId: Id<"conversations">, statusTs: number): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || !isSpawnedWorker(conv)) return;
  await ctx.scheduler.runAfter(NEEDS_INPUT_IDLE_CHECK_DELAY_MS, internal.workerSettle.tellParent, {
    conversation_id: conversationId,
    status_ts: statusTs,
  });
}

// A session other sessions wait on (`cast state --status dormant --on <it>`,
// lib/waitingOn.ts) tells them when it settles, one idle grace later as a
// worker tells its lead, so its closing `cast state` has landed. One index
// read per settle, on the conversation id; nothing is scheduled while nobody waits.
// A kill passes no status time: the kill itself is the settle.
export async function scheduleSessionWaiters(ctx: any, conversationId: Id<"conversations">, statusTs?: number): Promise<void> {
  if (!ctx.scheduler) return;
  const waiter = await ctx.db
    .query("conversations")
    .withIndex("by_waiting_on", (q: any) => q.eq("waiting_on.kind", "session").eq("waiting_on.ref", String(conversationId)))
    .first();
  if (!waiter) return;
  await ctx.scheduler.runAfter(statusTs === undefined ? 0 : NEEDS_INPUT_IDLE_CHECK_DELAY_MS, internal.waitingOn.tellSessionWaiters, {
    conversation_id: conversationId,
    ...(statusTs !== undefined ? { status_ts: statusTs } : {}),
  });
}

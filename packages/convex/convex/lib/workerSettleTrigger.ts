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
  short_id?: string;
  title?: string;
  thread_state?: string;
  thread_state_status?: string;
  thread_state_at?: number;
  thread_state_msg_count?: number;
  hand_wake_notified_key?: string;
  reported_to_parent_at?: number;
};

export function isSpawnedWorker(c: WorkerRow): boolean {
  return c.is_subagent === true && !!c.parent_conversation_id && !c.agent_task_id && !c.is_workflow_sub &&
    !c.org_role_id && !c.standing_role_id && !c.agent_team_name;
}

export async function scheduleWorkerSettle(ctx: any, conversationId: Id<"conversations">, statusTs: number): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || !isSpawnedWorker(conv)) return;
  await ctx.scheduler.runAfter(NEEDS_INPUT_IDLE_CHECK_DELAY_MS, internal.workerSettle.tellParent, {
    conversation_id: conversationId,
    status_ts: statusTs,
  });
}

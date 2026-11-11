// The trigger half of session goals that managedSessions calls on every turn
// end. Kept apart from sessionGoals.ts so the status path does not import the
// judge, conversations and the whole function graph behind them (ct-92329).
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../functions";

/** How long after a turn end the judge reads: the turn's last messages sync a moment after its status. */
export const GOAL_JUDGE_DELAY_MS = 8_000;

export type Goal = Doc<"session_goals">;

/** The session's goal: its newest row, whatever its status. */
export async function readSessionGoal(ctx: { db: any }, conversationId: Id<"conversations">): Promise<Goal | null> {
  return await ctx.db.query("session_goals").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId)).order("desc").first();
}

/**
 * Called from applyAgentStatus whenever a turn ends, for any backend. `turnKey`
 * names the turn end (its stamp, else the status change time), so a turn end
 * reported twice is judged once. A session settling as `waiting` still has
 * background work that will wake it, and one at a permission prompt is mid
 * turn, so their goal waits for the turn to really end.
 */
const SAME_TURN_MS = 5_000;

export async function scheduleGoalJudge(ctx: MutationCtx, conversationId: Id<"conversations">, turnKey: number, agentStatus: string): Promise<void> {
  const goal = await readSessionGoal(ctx, conversationId);
  if (!goal || goal.status !== "active") return;
  const now = Date.now();
  // Two reports of one turn end (a settle, then its stamp) land seconds apart; a real next turn needs a delivery and work in between.
  const sameTurn = goal.judged_status_ts !== undefined && Math.abs(goal.judged_status_ts - turnKey) < SAME_TURN_MS;
  if (agentStatus === "waiting" || agentStatus === "permission_blocked" || sameTurn) {
    await ctx.db.patch(goal._id, { last_activity_at: now });
    return;
  }
  await ctx.db.patch(goal._id, { judged_status_ts: turnKey, last_activity_at: now });
  await ctx.scheduler.runAfter(GOAL_JUDGE_DELAY_MS, internal.sessionGoals.judgeTurn, { goal_id: goal._id, turn_key: turnKey, attempt: 0 });
}

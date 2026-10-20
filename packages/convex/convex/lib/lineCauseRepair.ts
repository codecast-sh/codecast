// The LE16 repair's reading of a line cause (workflow_runs.repairLineCauseStatus):
// what status and close time a cause the old run end left in review should hold.

import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";

/**
 * The status a cause should hold, given the completed line run bound to it,
 * when the old run end overwrote it with in_review (no history row, so the
 * overwrite is silent): shipped and dissolved are done, dropped is dropped,
 * parked and a review reject are open. Null leaves the row alone. A status
 * moved through the history after the run ended was a person's, and stands.
 */
export function repairedLineStatus(
  task: { status: string; review_verdict?: { verdict: string } | null },
  run: { status: string; node_statuses?: Parameters<typeof lineRunOutcome>[0] },
): "done" | "dropped" | "open" | null {
  if (run.status !== "completed" || task.status !== "in_review") return null;
  const end = lineRunOutcome(run.node_statuses)?.kind;
  if (end === "shipped" || end === "dissolved") return "done";
  if (end === "dropped") return "dropped";
  if (end === "parked") return "open";
  if (!end && isLineRun(run.node_statuses) && task.review_verdict?.verdict === "reject") return "open";
  return null;
}

export const statusHistory = async (ctx: any, taskId: any) =>
  (await ctx.db.query("task_history").withIndex("by_task_id", (q: any) => q.eq("task_id", taskId)).collect()).filter((h: any) => h.field === "status");

/**
 * The close time a cause this repair already closed should carry: the time
 * its run reached the end. A first pass of the repair stamped its own time;
 * that write is the newest status row, a system's, after the run ended, at
 * exactly the closed_at it left. A person's later close stands. Null leaves it.
 */
export function repairedClosedAt(
  task: { status: string; closed_at?: number | null },
  run: { status: string; updated_at: number; node_statuses?: Parameters<typeof lineRunOutcome>[0] },
  history: ReadonlyArray<{ created_at: number; new_value?: string; actor_type?: string }>,
): number | null {
  if (run.status !== "completed" || (task.status !== "done" && task.status !== "dropped") || !task.closed_at) return null;
  const end = lineRunOutcome(run.node_statuses);
  if (!end || end.kind === "parked" || Math.abs(task.closed_at - end.at) < 60_000) return null;
  const last = [...history].sort((a, b) => b.created_at - a.created_at)[0];
  const byRepair = !!last && last.created_at > run.updated_at && last.created_at === task.closed_at && last.new_value === task.status && (last.actor_type ?? "system") === "system";
  return byRepair ? end.at : null;
}

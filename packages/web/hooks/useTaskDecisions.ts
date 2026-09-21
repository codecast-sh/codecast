import { useMemo } from "react";
import { useCollectionRows } from "./useCollectionRows";
import { type SessionDecisionItem } from "../store/inboxStore";
import { heldDecisionFor, type LineTask } from "../lib/taskLine";

// Decisions bound to a task (docs/architecture/decisions-as-documents.md D3,
// the-line.md L10): open ones as cards under the task's description, the
// answered and dismissed ones folded under a disclosure with their answer.
// Same store rows the queue renders, same answer action; a card moves from
// the open list to the fold the moment it is answered.
export const sig = (d: SessionDecisionItem) => `${d.status}:${d.task_id ?? ""}:${d.station ?? ""}:${d.blocking ? 1 : 0}:${d.updated_at ?? 0}:${d.answer_index ?? ""}:${d.answer_text ?? ""}`;

/** Whether any pending decision blocks this task. Wider than useTaskHold,
 *  which matches the station too: the page collapses its description for a
 *  blocking question wherever the task stands, so the answer is above the
 *  fold rather than below a body nobody can act on yet. */
export function useTaskIsBlocked(taskId: string): boolean {
  const where = useMemo(() => (d: SessionDecisionItem) => d.task_id === taskId && d.status === "pending" && d.blocking, [taskId]);
  return useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig }).length > 0;
}

/** L5: the pending blocking decision holding the task at its current
 *  station, from the store's decision rows. */
export function useTaskHold(task: Pick<LineTask, "_id" | "status" | "status_id">): SessionDecisionItem | undefined {
  const where = useMemo(() => (d: SessionDecisionItem) => d.task_id === task._id && d.status === "pending" && d.blocking, [task._id]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig });
  return heldDecisionFor(task, rows);
}

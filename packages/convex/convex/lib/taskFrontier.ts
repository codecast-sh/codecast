// The ready frontier's order (docs/architecture/task-graph.md TG7). The rule
// is shared/tasks' frontierOrder; this module reads the plans it needs from
// the database.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { frontierOrder } from "@codecast/shared/tasks";

type ReadCtx = Pick<QueryCtx, "db">;

/** `tasks` in frontier order: live before stale, priority, plan order, oldest. */
export async function orderFrontier<T extends Doc<"tasks">>(ctx: ReadCtx, tasks: T[], now: number): Promise<T[]> {
  const planIds = [...new Set(tasks.flatMap((t) => (t.plan_id ? [t.plan_id] : [])))];
  const plans = await Promise.all(planIds.map((id) => ctx.db.get(id)));
  const position = new Map<string, number>();
  for (const plan of plans) (plan?.task_ids ?? []).forEach((id, i) => position.set(String(id), i));
  return frontierOrder(tasks, { now, planPosition: (t) => position.get(String(t._id)) });
}

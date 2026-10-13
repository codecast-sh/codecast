// What one line run costs, from the priced runs in the store: the dollar
// figure a consequential switch's review leads with (ConsequentialSwitch).
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import type { RunCost } from "./lineStartLedger";

/** What a run costs, from the priced runs in the store: this project's when it has three or more, else every
 *  line's in the workspace; null when there are too few to call a price. A run whose card recorded no cost
 *  reads as zero and is left out. */
export function useRunCost(projectId: string | null): RunCost | null {
  const sig = useInboxStore((s) => {
    const tasks = s.tasks as Record<string, { project_id?: string | null }>;
    let own = 0, ownN = 0, all = 0, allN = 0;
    for (const r of Object.values((s as any).workflowRuns ?? {}) as Array<{ task_id?: string; card_cost_usd?: number }>) {
      if (typeof r.card_cost_usd !== "number" || r.card_cost_usd <= 0) continue;
      all += r.card_cost_usd; allN++;
      if (projectId && r.task_id && tasks[r.task_id]?.project_id === projectId) { own += r.card_cost_usd; ownN++; }
    }
    // Under three priced runs is an anecdote, not a price.
    return ownN >= 3 ? `${own}|${ownN}|project` : allN >= 3 ? `${all}|${allN}|workspace` : "";
  });
  return useMemo(() => {
    if (!sig) return null;
    const [sum, n, scope] = sig.split("|");
    return { avgUsd: Number(sum) / Number(n), runs: Number(n), scope: scope as RunCost["scope"] };
  }, [sig]);
}

// What one line run costs, from the priced runs in the store: the billed
// money a consequential switch's review leads with (ConsequentialSwitch), and
// its subscription sessions' list price beside it.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import type { RunCost } from "./lineStartLedger";

/** What a run costs, from the priced runs in the store: this project's when it has three or more, else every
 *  line's in the workspace; null when there are too few to call a price. A run whose card recorded no cost
 *  reads as zero and is left out. */
export function useRunCost(projectId: string | null): RunCost | null {
  const sig = useInboxStore((s) => {
    const tasks = s.tasks as Record<string, { project_id?: string | null }>;
    const own = { billed: 0, list: 0, n: 0 }, all = { billed: 0, list: 0, n: 0 };
    for (const r of Object.values((s as any).workflowRuns ?? {}) as Array<{ task_id?: string; card_billed_usd?: number; card_list_usd?: number }>) {
      const billed = r.card_billed_usd ?? 0, list = r.card_list_usd ?? 0;
      if (billed + list <= 0) continue;
      for (const t of projectId && r.task_id && tasks[r.task_id]?.project_id === projectId ? [all, own] : [all]) { t.billed += billed; t.list += list; t.n++; }
    }
    // Under three priced runs is an anecdote, not a price.
    const pick = own.n >= 3 ? { ...own, scope: "project" } : all.n >= 3 ? { ...all, scope: "workspace" } : null;
    return pick ? `${pick.billed}|${pick.list}|${pick.n}|${pick.scope}` : "";
  });
  return useMemo(() => {
    if (!sig) return null;
    const [billed, list, n, scope] = sig.split("|");
    return { billedUsd: Number(billed) / Number(n), listUsd: Number(list) / Number(n), runs: Number(n), scope: scope as RunCost["scope"] };
  }, [sig]);
}

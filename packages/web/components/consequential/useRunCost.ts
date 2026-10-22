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
    const { all, by } = pricedRuns((s as { workflowRuns?: Record<string, PricedRun> }).workflowRuns, s.tasks as Record<string, { project_id?: string | null }>);
    const own = (projectId && by.get(projectId)) || { billed: 0, list: 0, n: 0 };
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

type PricedRun = { task_id?: string; card_billed_usd?: number; card_list_usd?: number };
type Tally = { billed: number; list: number; n: number };
/** The priced runs' totals, every line's and each project's, read once per change of the runs or the tasks: every
 *  control that names a price reads the same totals, so a list of them costs one pass over the runs, not one each. */
const priced = new WeakMap<object, { tasks: object; all: Tally; by: Map<string, Tally> }>();
const NO_RUNS: Record<string, PricedRun> = {};

function pricedRuns(runs: Record<string, PricedRun> | undefined, tasks: Record<string, { project_id?: string | null }>): { all: Tally; by: Map<string, Tally> } {
  const rows = runs ?? NO_RUNS;
  const hit = priced.get(rows);
  if (hit && hit.tasks === tasks) return hit;
  const all = { billed: 0, list: 0, n: 0 };
  const by = new Map<string, Tally>();
  for (const r of Object.values(rows)) {
    const billed = r.card_billed_usd ?? 0, list = r.card_list_usd ?? 0;
    if (billed + list <= 0) continue;
    const p = r.task_id ? tasks?.[r.task_id]?.project_id : null;
    const own = p ? by.get(p) ?? by.set(p, { billed: 0, list: 0, n: 0 }).get(p)! : null;
    for (const t of own ? [all, own] : [all]) { t.billed += billed; t.list += list; t.n++; }
  }
  const read = { tasks, all, by };
  priced.set(rows, read);
  return read;
}

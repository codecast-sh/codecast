"use client";
// The line's start switch through the one consequential flow
// (ConsequentialSwitch): what turning a project's line on starts, read from
// the same admission every line surface reads (useLineAdmission), and the one
// control every line surface uses to turn it on. Turning it on lets the sweep
// (convex orgLine.sweep, every two minutes) start a paid agent session on each
// ready problem, up to the free places and the role's sessions a day.
import { useMemo, type ReactNode } from "react";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../store/inboxStore";
import type { NotReady } from "../line/map/LineStartSwitch";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { ConsequentialSwitch, type SwitchTriggerProps } from "./ConsequentialSwitch";
import { lineStartLedger, type RunCost } from "./lineStartLedger";

/** What a run costs, from the priced runs in the store: this project's when it has three or more, else every
 *  line's in the workspace; null when there are too few to call a price. A run whose card recorded no cost
 *  reads as zero and is left out. */
function useRunCost(projectId: string | null): RunCost | null {
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

/** One project's start switch as a control: off, pressing it opens the review; on, pressing it turns the line off.
 *  `admit`: the surface's own admission when it already holds one, so the control and the surface read one queue. */
export function LineStartControl({ projectId: given_id, project, admit: given, waiting, ready, notReady, trigger, className, label, triggerProps }: {
  /** The project whose line it is; without it the review has no name or past cost to show. */
  projectId?: string | null;
  project?: string;
  admit?: ReturnType<typeof useLineAdmission>;
  waiting?: number | null;
  ready?: number | null;
  notReady?: NotReady;
  trigger?: (p: SwitchTriggerProps) => ReactNode;
  className?: string;
  label?: string;
  triggerProps?: Record<string, string | undefined>;
}) {
  const own = useLineAdmission(given ? null : given_id ?? null);
  const admit = given ?? own;
  // A surface that holds the admission but not the project: the role's own, when it leads exactly one.
  const led = admit.role?.scope.project_ids;
  const projectId = given_id ?? (led?.length === 1 ? led[0] : null);
  const title = useInboxStore((s) => projectId ? (s.projects as Record<string, { title?: string }>)[projectId]?.title : undefined);
  const cost = useRunCost(projectId ?? null);
  const a = admit.admission;
  if (!a?.role) return null;
  const ledger = lineStartLedger({ project: project ?? title ?? "this project", admission: a, roleOwnSwitchOff: !autonomyOn(admit.role?.trust), waiting, ready, notReady, cost });
  return <ConsequentialSwitch on={a.on} ledger={ledger} onTurnOn={() => admit.setOn(true)} onTurnOff={() => admit.setOn(false)} trigger={trigger} className={className} label={label} triggerProps={triggerProps} />;
}

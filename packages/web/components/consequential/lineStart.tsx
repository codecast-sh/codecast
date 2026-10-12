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

/** The mean recorded cost of the project's past runs, from the runs in the store; null when none recorded one. */
function useRunCost(projectId: string | null): RunCost | null {
  const sig = useInboxStore((s) => {
    if (!projectId) return "";
    const tasks = s.tasks as Record<string, { project_id?: string | null }>;
    let sum = 0, n = 0;
    for (const r of Object.values((s as any).workflowRuns ?? {}) as Array<{ task_id?: string; card_cost_usd?: number }>) {
      if (typeof r.card_cost_usd !== "number" || !r.task_id || tasks[r.task_id]?.project_id !== projectId) continue;
      sum += r.card_cost_usd; n++;
    }
    return n ? `${sum}|${n}` : "";
  });
  return useMemo(() => {
    if (!sig) return null;
    const [sum, n] = sig.split("|").map(Number);
    return { avgUsd: sum / n, runs: n };
  }, [sig]);
}

/** One project's start switch as a control: off, pressing it opens the review; on, pressing it turns the line off.
 *  `admit`: the surface's own admission when it already holds one, so the control and the surface read one queue. */
export function LineStartControl({ projectId, project, admit: given, waiting, ready, notReady, trigger, className, label }: {
  projectId: string;
  project?: string;
  admit?: ReturnType<typeof useLineAdmission>;
  waiting?: number | null;
  ready?: number | null;
  notReady?: NotReady;
  trigger?: (p: SwitchTriggerProps) => ReactNode;
  className?: string;
  label?: string;
}) {
  const own = useLineAdmission(given ? null : projectId);
  const admit = given ?? own;
  const title = useInboxStore((s) => (s.projects as Record<string, { title?: string }>)[projectId]?.title);
  const cost = useRunCost(projectId);
  const a = admit.admission;
  if (!a?.role) return null;
  const ledger = lineStartLedger({ project: project ?? title ?? "this project", admission: a, roleOwnSwitchOff: !autonomyOn(admit.role?.trust), waiting, ready, notReady, cost });
  return <ConsequentialSwitch on={a.on} ledger={ledger} onTurnOn={() => admit.setOn(true)} onTurnOff={() => admit.setOn(false)} trigger={trigger} className={className} label={label} />;
}

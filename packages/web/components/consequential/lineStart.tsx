"use client";
// The line's start switch through the one consequential flow
// (ConsequentialSwitch): what turning a project's line on starts, read from
// the same admission every line surface reads (useLineAdmission), and the one
// control every line surface uses to turn it on. Turning it on lets the sweep
// (convex orgLine.sweep, every two minutes) start a paid agent session on each
// ready problem, up to the free places and the role's sessions a day.
import type { ReactNode } from "react";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../store/inboxStore";
import type { NotReady } from "../line/map/LineStartSwitch";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { ConsequentialSwitch, type SwitchTriggerProps } from "./ConsequentialSwitch";
import { lineStartLedger } from "./lineStartLedger";
import { useRunCost } from "./useRunCost";

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
  // The waiting problems by priority, the order the sweep takes them (convex orgLine lineCandidates).
  const firstSig = useInboxStore((s) => {
    if (!projectId) return "";
    const rank: Record<string, number> = { urgent: 0, p0: 0, high: 1, p1: 1, medium: 2, p2: 2, low: 3, p3: 3 };
    return (Object.values(s.tasks) as Array<{ project_id?: string | null; status?: string; cause?: unknown; short_id?: string; title?: string; priority?: string; created_at?: number }>)
      .filter((t) => t.project_id === projectId && t.status === "open" && !!t.cause)
      .sort((x, y) => (rank[x.priority ?? ""] ?? 4) - (rank[y.priority ?? ""] ?? 4) || (x.created_at ?? 0) - (y.created_at ?? 0))
      .slice(0, 3).map((t) => t.short_id ?? "").filter(Boolean).join("\n");
  });
  const a = admit.admission;
  if (!a?.role) return null;
  const ledger = lineStartLedger({ project: project ?? title ?? "this project", admission: a, roleOwnSwitchOff: !autonomyOn(admit.role?.trust), waiting, ready, notReady, cost, first: firstSig ? firstSig.split("\n") : [] });
  return <ConsequentialSwitch on={a.on} ledger={ledger} onTurnOn={() => admit.setOn(true)} onTurnOff={() => admit.setOn(false)} trigger={trigger} className={className} label={label} triggerProps={triggerProps} />;
}

"use client";
// The line's start switch through the one consequential flow
// (ConsequentialSwitch): what turning a project's line on starts, read from
// the same admission every line surface reads (useLineAdmission), and the one
// control every line surface uses to turn it on. Turning it on lets the sweep
// (convex orgLine.sweep, every two minutes) start a paid agent session on each
// ready problem, up to the free places and the role's sessions a day.
import { useState, type ReactNode } from "react";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import { useInboxStore } from "../../store/inboxStore";
import { causeName, startableCause, type LineCauseTask } from "../../lib/lineFlow";
import { goalOfRefs, inStartOrder, type RankTask } from "../../lib/line/lineStartOrder";
import { problemListName } from "../../lib/line/problemTable";
import type { NotReady } from "./lineStartLedger";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { ConsequentialSwitch, type SwitchTriggerProps } from "./ConsequentialSwitch";
import { DEFAULT_DAY_CAP, dayCapOf, lineStartLedger } from "./lineStartLedger";
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
  // The problems the sweep would start, in the order it takes them (convex orgLine rankedCandidates: the one line
  // priority, goal x severity x findings, then oldest first), named as the lists name them: never a blocked one
  // (assigned, ungrounded, held by a run), which it skips. As many as a press starts at most: the line's places.
  const places = admit.admission?.slots ?? 5;
  const firstSig = useInboxStore((s) => {
    if (!projectId) return "";
    const tasks = (Object.values(s.tasks) as Array<LineCauseTask & RankTask & { short_id?: string; title?: string }>).filter((t) => t.project_id === projectId && !!t.cause && startableCause(t));
    return inStartOrder(tasks, goalOfRefs(Object.values(s.projects ?? {}) as Array<{ short_id?: string; priority?: string }>))
      .slice(0, places).map((t) => problemListName({ title: t.title ?? t.short_id ?? "", name: causeName(t) })).join("\n");
  });
  // A role with no daily cap gets one with the switch: picked in the review, 10 unless the person picks another.
  const [dayCap, setDayCap] = useState<number | null>(DEFAULT_DAY_CAP);
  const a = admit.admission;
  if (!a?.role) return null;
  const capless = a.handsCap == null;
  const ledger = lineStartLedger({ project: project ?? title ?? "this project", admission: a, roleOwnSwitchOff: !autonomyOn(admit.role?.trust), waiting, ready, notReady, cost, first: firstSig ? firstSig.split("\n") : [], ...(capless ? { dayCap } : {}) });
  return <ConsequentialSwitch on={a.on} ledger={ledger} onTurnOn={() => admit.setOn(true, capless ? dayCap : undefined)} onTurnOff={() => admit.setOn(false)} onPick={(o) => setDayCap(dayCapOf(o))} trigger={trigger} className={className} label={label} triggerProps={triggerProps} />;
}

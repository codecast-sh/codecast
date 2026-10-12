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
import type { LineAdmission } from "../../lib/lineFlow";
import { startsAtOnce, type NotReady } from "../line/map/LineStartSwitch";
import { useLineAdmission } from "../line/map/useLineAdmission";
import { ConsequentialSwitch, type SwitchLedger, type SwitchTriggerProps } from "./ConsequentialSwitch";

/** What past runs on this project cost: the mean of the runs whose card recorded a cost. */
export type RunCost = { avgUsd: number; runs: number };

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type LineStartFacts = {
  project: string;
  admission: LineAdmission;
  /** The role's own switch is off, and turning the line on turns that on too (useLineAdmission lineSwitchFields). */
  roleOwnSwitchOff?: boolean;
  /** Every problem waiting on this line, and how many of them are ready to start (lineFlow waitingReadiness). */
  waiting?: number | null;
  ready?: number | null;
  notReady?: NotReady;
  cost?: RunCost | null;
};

/** The review of a line's start switch, as data. */
export function lineStartLedger({ project, admission: a, roleOwnSwitchOff = false, waiting = null, ready = null, notReady = [], cost = null }: LineStartFacts): SwitchLedger {
  const who = a.role ? `@${a.role.handle}` : "The lead";
  const queued = ready ?? a.queued ?? null;
  const now = startsAtOnce({ ...a, queued });
  const all = waiting ?? queued;
  const held = notReady.reduce((n, r) => n + r.count, 0) || (waiting != null && queued != null && waiting > queued ? waiting - queued : 0);
  const perDay = a.handsCap;

  const figures: SwitchLedger["figures"] = [
    { value: now == null ? `≤${a.slots}` : String(now), label: now === 1 ? "session starts now" : "sessions start now", tone: now === 0 ? undefined : "warn" },
    ...(all != null ? [{ value: String(all), label: all === 1 ? "problem waiting" : "problems waiting" }] : []),
    { value: String(a.slots), label: "at a time" },
    ...(perDay != null ? [{ value: String(perDay), label: "a day at most" }] : []),
  ];

  const rows: SwitchLedger["rows"] = [];
  rows.push({ k: "Each one", v: `A paid agent session writes a fix in ${project}'s repo`, sub: "It runs until its fix waits for your decision" });
  if (cost && cost.runs > 0) {
    const day = perDay != null ? `, so at most about ${usd(cost.avgUsd * perDay)} a day` : "";
    rows.push({ k: "Cost", v: `About ${usd(cost.avgUsd)} a run${day}`, sub: `Mean of the last ${plural(cost.runs, "run")} here${now ? `. The ${now} starting now: about ${usd(cost.avgUsd * now)}` : ""}`, tone: "warn" });
  } else {
    rows.push({ k: "Cost", v: "Model time per session, no price measured here yet", sub: perDay != null ? `Bounded by ${plural(perDay, "session")} a day` : undefined, tone: "warn" });
  }
  const rest = queued != null && now != null ? queued - now : 0;
  if (rest > 0 && perDay) rows.push({ k: "Pace", v: `All ${queued} ready in about ${plural(1 + Math.ceil(rest / perDay), "day")}`, sub: held ? `${held} more wait on you or another run first` : undefined });
  else if (held) rows.push({ k: "Pace", v: `${held} wait on you or another run first` });
  rows.push({ k: "Ships", v: "Nothing without you", sub: "No merge and no deploy until you approve that fix", tone: "ok" });
  if (roleOwnSwitchOff) rows.push({ k: "Also on", v: `${who} starts other work in its area on its own`, sub: "And answers decisions there without asking", tone: "warn" });
  if (a.role?.paused) rows.push({ k: "Lead", v: `${who} is paused`, sub: "Nothing starts until it resumes", tone: "warn" });

  return {
    name: "Auto-start",
    subject: project,
    figures,
    rows,
    yours: ["Approve, revise or drop every fix", "Merge and ship", "Places and the daily cap"],
    stop: "Switch Auto-start off: nothing new starts. Sessions already running finish and wait for you.",
    confirm: now ? `Turn on, start ${now} now` : "Turn on",
  };
}

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

// What turning a project's line on starts, as the review's data (ConsequentialSwitch
// SwitchLedger): read from the same admission every line surface reads. Its own
// file with no component in it, so the numbers are tested without a browser.
import type { LineAdmission } from "../../lib/lineFlow";
import { startsAtOnce, type NotReady } from "../line/map/LineStartSwitch";
import type { SwitchLedger } from "./ConsequentialSwitch";

/** What a run costs, from runs whose card recorded a price: this project's own, else every line's in the workspace. */
export type RunCost = { avgUsd: number; runs: number; scope: "project" | "workspace" };

/** Dollars to the precision an estimate deserves: whole dollars from $2 up. */
export const usd = (n: number) => (n >= 2 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  /** The short ids of the waiting problems in the order the line takes them: the review names the ones that start. */
  first?: string[];
};

/** The review of a line's start switch, as data. */
export function lineStartLedger({ project, admission: a, roleOwnSwitchOff = false, waiting = null, ready = null, notReady = [], cost = null, first = [] }: LineStartFacts): SwitchLedger {
  const who = a.role ? `@${a.role.handle}` : "The lead";
  const queued = ready ?? a.queued ?? null;
  const now = startsAtOnce({ ...a, queued });
  const all = waiting ?? queued;
  const held = notReady.reduce((n, r) => n + r.count, 0) || (waiting != null && queued != null && waiting > queued ? waiting - queued : 0);
  const perDay = a.handsCap;
  const rest = queued != null && now != null ? queued - now : 0;
  const named = now ? first.slice(0, Math.min(now, 3)) : [];

  const figures: SwitchLedger["figures"] = [
    // The sweep (convex orgLine.sweep) runs every two minutes, so "now" is within that.
    { value: now == null ? `≤${a.slots}` : String(now), label: "start within 2 min", tone: now === 0 ? undefined : "warn" },
    ...(all != null && all !== now ? [{ value: String(all), label: "waiting" }] : []),
    // No daily cap is the loudest fact a cost can have: said as one, never left blank.
    perDay != null ? dayLimitFigure(perDay) : { value: "∞", label: "a day, no cap", tone: "warn" },
    // Without a daily cap the bound is the queue: what working through all of it costs.
    perDay != null ? dayCostFigure(cost, perDay) : cost && queued ? { value: `~${usd(cost.avgUsd * queued)}`, label: `all ${queued}, est.`, tone: "warn" } : { value: "$?", label: "not priced", tone: "warn" },
  ];
  const rows: SwitchLedger["rows"] = [
    { k: "Each", v: "1 agent session per problem" },
    { k: "Repo", v: project },
    ...(named.length ? [{ k: "Starting", v: [...named, ...(now! > named.length ? [`+${now! - named.length}`] : [])].join(" · ") }] : []),
    { k: "Then", v: rest > 0 ? (perDay ? `All ${queued} in ~${plural(1 + Math.ceil(rest / perDay), "day")}` : `All ${queued}, ${a.slots} at a time`) : "New ones as they arrive" },
    ...(held ? [{ k: "Held", v: `${held} wait on you` }] : []),
    { k: "At once", v: `${a.slots} max` },
    { k: "Merges", v: MERGES_NEVER, tone: "ok" as const },
    priceRow(cost),
    ...(roleOwnSwitchOff ? [{ k: "Also on", v: `${who} decides alone`, tone: "warn" as const }] : []),
    ...(a.role?.paused ? [{ k: "Lead", v: `${who} paused`, tone: "warn" as const }] : []),
    RUNNING_ROW,
  ];
  return {
    name: "Auto-start",
    subject: project,
    figures,
    rows,
    stop: STOP,
    // The button names everything the press commits to: the whole queue when more waits than starts now.
    confirm: !now ? "Turn on" : rest > 0 ? `Run all ${queued}` : `Start ${now}`,
  };
}

/** How every switch that starts sessions stops. */
export const STOP = "Switch off";

/** What switching off leaves alone, as a row beside STOP. */
export const RUNNING_ROW = { k: "Running ones", v: "Finish" };

/** What every line says about merging. */
export const MERGES_NEVER = "Never without you";

/** The sessions a day the lead may start. */
export function dayLimitFigure(perDay: number): SwitchLedger["figures"][number] {
  return { value: String(perDay), label: "a day, max" };
}

/** A full day at that limit, in dollars; no price, no number. */
export function dayCostFigure(cost: RunCost | null | undefined, perDay: number | null): SwitchLedger["figures"][number] {
  if (!cost || perDay == null) return { value: "$?", label: "not priced", tone: "warn" };
  return { value: `~${usd(cost.avgUsd * perDay)}`, label: "a day, est.", tone: "warn" };
}

/** What one session costs and how many runs say so. */
export function priceRow(cost: RunCost | null | undefined): SwitchLedger["rows"][number] {
  return cost
    ? { k: "Per session", v: `~${usd(cost.avgUsd)} · ${cost.runs}-run avg` }
    : { k: "Per session", v: "Not priced yet", tone: "warn" };
}

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
  /** The waiting problems in the order the line takes them, as "ct-12 Title": the review names the ones that start. */
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

  const figures: SwitchLedger["figures"] = [
    // The sweep (convex orgLine.sweep) runs every two minutes, so "now" is within that.
    { value: now == null ? `≤${a.slots}` : String(now), label: now === 1 ? "session starts within ~2 min" : "sessions start within ~2 min", sub: all != null && all !== now ? `of ${all} waiting` : undefined, tone: now === 0 ? undefined : "warn" },
    ...(perDay != null ? [dayLimitFigure(perDay, a.hands, `${a.slots} at a time`)] : []),
    dayCostFigure(cost, perDay),
  ];

  const rows: SwitchLedger["rows"] = [];
  const named = now ? first.slice(0, Math.min(now, 3)) : [];
  rows.push({ k: "Does", v: `One paid agent session per waiting problem, writing its fix in ${project}'s repo`, list: named.length ? [...named, ...(now! > named.length ? [`and ${now! - named.length} more`] : [])] : undefined });
  const rest = queued != null && now != null ? queued - now : 0;
  if (rest > 0 && perDay) rows.push({ k: "Then", v: `All ${queued} ready in about ${plural(1 + Math.ceil(rest / perDay), "day")}${held ? `; ${held} more wait on you first` : ""}` });
  else rows.push({ k: "Then", v: `Each new problem starts by itself as it arrives${held ? `; ${held} wait on you first` : ""}` });
  rows.push({ k: "Merges", v: MERGES_NEVER, tone: "ok" });
  rows.push(priceRow(cost));
  if (a.role?.paused) rows.push({ k: "Lead", v: `${who} is paused: nothing starts until it resumes`, tone: "warn" });

  return {
    name: "Auto-start",
    subject: project,
    figures,
    lead: roleOwnSwitchOff ? { v: `Also lets ${who} answer its sessions' questions for you in ${project}`, sub: "And start other work there. That switch is off today" } : undefined,
    rows,
    stop: STOP,
    confirm: now ? `Turn on, start ${now} now` : "Turn on",
  };
}

/** What every line says about merging, in the same words. */
export const MERGES_NEVER = "Never without you: no merge, no deploy until you approve a fix";

/** The sessions a day the lead may start, one limit for everything it does. */
export function dayLimitFigure(perDay: number, used: number | null | undefined, extra?: string): SwitchLedger["figures"][number] {
  return { value: String(perDay), label: "sessions a day at most", sub: [extra, `${used ?? 0} used today`].filter(Boolean).join(" · ") };
}

/** The most a day costs at that limit, with its arithmetic and the month beside it; no price, no number. */
export function dayCostFigure(cost: RunCost | null | undefined, perDay: number | null): SwitchLedger["figures"][number] {
  if (!cost || perDay == null) return { value: "$?", label: "a day: no run priced yet", tone: "warn" };
  // The month is thirty of the day as shown, so the two figures agree to the eye.
  const day = Math.round(cost.avgUsd * perDay);
  return { value: `~${usd(day)}`, label: `a typical full day: ${perDay} × ~${usd(cost.avgUsd)}`, sub: `~${usd(day * 30)} a month. Sessions are capped, dollars are not`, tone: "warn" };
}

/** Where the dollar figures come from and how soft they are, in one line. */
export function priceRow(cost: RunCost | null | undefined): SwitchLedger["rows"][number] {
  return cost
    ? { k: "Price", v: `~${usd(cost.avgUsd)} is the average of ${plural(cost.runs, "past run")}${cost.scope === "project" ? " here" : " on other projects"}; one session can cost more` }
    : { k: "Price", v: "Unknown: no run has recorded a cost yet. Billed to your agent accounts", tone: "warn" };
}

/** How every switch that starts sessions stops, in the same words. */
export const STOP = "Switch it off: nothing new starts. Running sessions finish and wait for you, or stop any one from its page.";

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

  const dayUsd = cost && perDay != null ? cost.avgUsd * perDay : null;
  const figures: SwitchLedger["figures"] = [
    { value: now == null ? `≤${a.slots}` : String(now), label: now === 1 ? "session starts now" : "sessions start now", tone: now === 0 ? undefined : "warn" },
    // The waiting count is its own tile only when it differs from what starts.
    ...(all != null && all !== now ? [{ value: String(all), label: all === 1 ? "problem waiting" : "problems waiting" }] : []),
    ...(perDay != null ? [{ value: String(perDay), label: "sessions a day at most", sub: now ? `these ${now} included` : undefined }] : []),
    ...(dayUsd != null ? [{ value: `~${usd(dayUsd)}`, label: "a day at that limit", sub: `~${usd(dayUsd * 30)} a month`, tone: "warn" as const }] : []),
  ];

  const rows: SwitchLedger["rows"] = [];
  rows.push({ k: "Each one", v: `One waiting problem, one paid agent session writing its fix in ${project}'s repo`, sub: "It stops when the fix is ready for you to approve" });
  rows.push(cost
    ? { k: "Cost", v: `About ${usd(cost.avgUsd)} a session${now && now > 1 ? `, ${usd(cost.avgUsd * now)} for the ${now} now` : ""}. No dollar cap`, sub: `The cap is ${perDay ?? "the"} sessions a day. Priced from ${plural(cost.runs, "past run")}${cost.scope === "project" ? " here" : " on your other projects"}`, tone: "warn" }
    : { k: "Cost", v: "Not priced yet, and no dollar cap", sub: `The cap is ${perDay ?? "the"} sessions a day, billed to your agent accounts`, tone: "warn" });
  const rest = queued != null && now != null ? queued - now : 0;
  if (rest > 0 && perDay) rows.push({ k: "Pace", v: `All ${queued} ready in about ${plural(1 + Math.ceil(rest / perDay), "day")}${held ? `; ${held} more wait on you first` : ""}` });
  else if (held) rows.push({ k: "Pace", v: `${held} more wait on you or another run first` });
  rows.push({ k: "Ships", v: "Nothing without you: no merge, no deploy until you approve a fix", tone: "ok" });
  rows.push({ k: "Limits", v: `${perDay != null ? `${perDay} a day, ` : ""}${a.slots} at once`, sub: `The daily ${perDay ?? ""} is ${who}'s, shared with its other work`.replace("  ", " ") });
  if (a.role?.paused) rows.push({ k: "Lead", v: `${who} is paused: nothing starts until it resumes`, tone: "warn" });

  return {
    name: "Auto-start",
    subject: project,
    figures,
    lead: roleOwnSwitchOff ? { v: `Also lets ${who} decide for you in ${project}`, sub: "It starts other work there and answers its sessions' questions itself. That switch is off today" } : undefined,
    rows,
    stop: STOP,
    confirm: now ? `Turn on, start ${now} now` : "Turn on",
  };
}

/** How every switch that starts sessions stops, in the same words. */
export const STOP = "Switch it off: nothing new starts. Running sessions finish and wait for you, or stop any one from its page.";

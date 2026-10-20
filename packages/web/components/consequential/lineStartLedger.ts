// What turning a project's line on starts, as the review's data (ConsequentialSwitch
// SwitchLedger): read from the same admission every line surface reads. Its own
// file with no component in it, so the numbers are tested without a browser.
import type { LineAdmission } from "../../lib/lineFlow";
import type { SwitchLedger } from "./ConsequentialSwitch";

/** How many problems turning the line on starts at once: the waiting ones,
 *  bounded by the free places and today's sessions left. Null while the
 *  queue is unknown. */
export function startsAtOnce(a: LineAdmission): number | null {
  if (a.queued == null) return null;
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  const handsLeft = a.hands != null && a.handsCap != null ? Math.max(0, a.handsCap - a.hands) : Infinity;
  return Math.min(a.queued, free, handsLeft);
}

/** Why the waiting problems that are not ready are held (lineFlow notReadyReasons). */
export type NotReady = ReadonlyArray<{ count: number; words: string }>;

/** What a run costs, from runs whose card recorded a price: this project's own, else every line's in the workspace.
 *  `billedUsd`: money a run bills (call nodes, sessions on API keys). `listUsd`: its subscription sessions at API
 *  list price, an equivalent never billed; they spend account quota. */
export type RunCost = { billedUsd: number; listUsd: number; runs: number; scope: "project" | "workspace" };

/** `times` runs' cost as a review figure: the money they would bill, est., with their list-price equivalent beside it. */
export function costFigure(cost: RunCost | null | undefined, times: number, what = ""): SwitchLedger["figures"][number] {
  if (!cost) return { value: "$?", label: "not priced", tone: "warn" };
  const billed = cost.billedUsd * times;
  return { value: `~${usd(billed)}`, label: what ? `${what}, billed` : "billed", ...(billed > 0 ? { tone: "warn" as const } : {}) };
}

/** Beside a cost figure: the runs' subscription sessions at API list price, an equivalent they spend as quota, not money. */
export function listRow(cost: RunCost | null | undefined, times = 1): SwitchLedger["rows"][number] {
  return { k: "List price", v: cost ? `~${usd(cost.listUsd * times)}, not billed` : "Not priced yet" };
}

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
  /** The waiting problems' names in the order the line takes them: the review names the ones that start. */
  first?: string[];
  /** For a role with no daily cap: the cap the person picks in the review (null: no cap), written with the switch.
   *  Absent: the review offers no pick. */
  dayCap?: number | null;
};

/** The daily caps the Turn on review offers a role that has none. */
export const DAY_CAP_OPTIONS = ["5", "10", "20", "No limit"] as const;
export const DEFAULT_DAY_CAP = 10;
export const dayCapOf = (option: string): number | null => (Number.isFinite(Number(option)) ? Number(option) : null);

/** The review of a line's start switch, as data. */
export function lineStartLedger({ project, admission: given, roleOwnSwitchOff = false, waiting = null, ready = null, notReady = [], cost = null, first = [], dayCap }: LineStartFacts): SwitchLedger {
  const who = given.role ? `@${given.role.handle}` : "The lead";
  // A role with no daily cap gets one picked here: the figures read the pick, as the sweep will once it is written.
  const offer = given.handsCap == null && dayCap !== undefined;
  const a = offer ? { ...given, handsCap: dayCap ?? null, hands: given.hands ?? 0 } : given;
  const queued = ready ?? a.queued ?? null;
  const now = startsAtOnce({ ...a, queued });
  const held = notReady.reduce((n, r) => n + r.count, 0) || (waiting != null && queued != null && waiting > queued ? waiting - queued : 0);
  const perDay = a.handsCap;
  // Nothing starts now though some are ready: why, and the ones taken first once that clears.
  const waits = now === 0 && queued ? waitRows(a, first) : null;
  // The ones after those named (starting now, else starting first), so the named plus Then is the ready figure.
  const rest = queued != null && now != null ? queued - (waits ? waits.first : now) : 0;

  const figures: SwitchLedger["figures"] = [
    // The sweep (convex orgLine.sweep) runs every two minutes, so "now" is within that.
    { value: now == null ? `≤${a.slots}` : String(now), label: "start within 2 min", tone: now === 0 ? undefined : "warn" },
    // The one total: what the sweep would start. The blocked ones are a row of their own, so the numbers add up.
    ...(queued != null && queued !== now ? [{ value: String(queued), label: "ready" }] : []),
    // No daily cap is the loudest fact a cost can have: said as one, never left blank.
    perDay != null ? dayLimitFigure(perDay) : { value: "∞", label: "a day, no limit", tone: "warn" },
    // Without a daily cap the bound is the queue: what working through all of it costs.
    perDay != null ? dayCostFigure(cost, perDay) : cost && queued ? costFigure(cost, queued, "all") : { value: "$?", label: "not priced", tone: "warn" },
  ];
  const rows: SwitchLedger["rows"] = [
    { k: "Each", v: "1 agent session per problem" },
    // The project is the review's subject. The problems the sweep takes first, by the names the lists give them, in its order.
    ...startingRow(now ?? 0, first),
    // Nothing starts now though some are ready: why (the day's sessions used, every place taken), and the ones that start
    // first once that clears, so the 0 is never a bare figure.
    ...(waits?.rows ?? []),
    { k: "Then", v: rest > 0 ? (perDay ? `${rest} more, ${perDay} a day` : `${rest} more, ${a.slots} at a time`) : "New ones as they arrive" },
    // Why the rest never start until someone moves them, in the sweep's own reasons.
    ...(held ? [{ k: "Blocked", v: blockedWords(held, notReady) }] : []),
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
    // The button says what the title says (Auto-start, off to on) and everything the press commits to.
    confirm: !now ? "Turn on" : rest > 0 ? `Turn on: run all ${queued}` : `Turn on: start ${now}`,
    ...(offer ? { pick: { k: "A day", options: DAY_CAP_OPTIONS, value: dayCap == null ? "No limit" : String(dayCap) } } : {}),
  };
}

/** The problems a press starts, every one by the name the lists give it, in the order they start: a press starts at
 *  most a line's places, so the names fit. Only a starter the caller could not name is counted. */
export function startingRow(count: number, first: ReadonlyArray<string>): SwitchLedger["rows"] {
  const named = first.slice(0, count);
  if (!named.length) return [];
  return [{ k: "Starting", v: plural(count, "problem"), list: [...named, ...(count > named.length ? [`+${count - named.length} more`] : [])] }];
}

/** Why a line about to turn on starts none of its ready problems now, and the ones it takes first after that. */
function waitRows(a: LineAdmission, first: ReadonlyArray<string>): { rows: SwitchLedger["rows"]; first: number } {
  const handsLeft = a.hands != null && a.handsCap != null ? Math.max(0, a.handsCap - a.hands) : Infinity;
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  const why = handsLeft === 0
    ? `Today's ${a.handsCap} sessions used: tomorrow`
    : free === 0 ? `All ${a.slots} places await decisions` : null;
  const next = first.slice(0, Math.max(1, Math.min(a.slots, handsLeft === 0 ? a.handsCap ?? a.slots : a.slots)));
  return {
    rows: [
      ...(why ? [{ k: "Not now", v: why, tone: "warn" as const }] : []),
      ...(next.length ? [{ k: "Starts first", v: plural(next.length, "problem"), list: [...next] }] : []),
    ],
    first: next.length,
  };
}

/** The blocked count, with its one reason when there is one and it reads at a glance ("4 are assigned to someone"). */
function blockedWords(held: number, notReady: NotReady): string {
  const only = notReady.length === 1 && notReady[0].count === held ? notReady[0].words : null;
  return only && only.split(/\s+/).length <= 6 ? only : String(held);
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
  if (perDay == null) return { value: "$?", label: "not priced", tone: "warn" };
  return costFigure(cost, perDay, "a day");
}

/** What one session costs and how many runs say so. */
export function priceRow(cost: RunCost | null | undefined): SwitchLedger["rows"][number] {
  return cost
    ? { k: "Per session", v: `~${usd(cost.billedUsd)} billed · ~${usd(cost.listUsd)} list · ${cost.runs}-run avg` }
    : { k: "Per session", v: "Not priced yet", tone: "warn" };
}


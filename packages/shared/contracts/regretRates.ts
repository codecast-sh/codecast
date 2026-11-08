// Regret-free merge rates and check miss rates (docs/architecture/regret.md).
// Pure: the convex query gathers the rows, this counts them, and the role
// settings and the Flows page read the same answer.

import { guessPhase } from "./linePhases";
import { stationWords } from "./flowMap";

/** The window when no traced link says otherwise; the measured one replaces it (windowFromLags). */
export const REGRET_WINDOW_DAYS = 14;
export const REGRET_WINDOW_MAX_DAYS = 30;
/** The share of top links the measured window covers. */
export const REGRET_WINDOW_COVERS = 0.75;
export const REGRET_RANGE_DAYS = 60;
const DAY_MS = 86_400_000;

/** How a change reached main: a run a role started (`line`), a check flow a person's session ran (`session_flow`),
 *  or neither (`outside`: no run, a Claude Code workflow run, or no session at all). */
export type RegretThrough = "line" | "session_flow" | "outside";

/** One change that landed on main, with what is known about it. */
export type RegretChange = {
  sha: string;
  landed_at: number;
  /** When the first live deploy holding it went live; null when none has yet (or none is recorded). */
  live_at: number | null;
  /** The traced fixes that changed its lines: when each landed, and whether this change was the fix's top introducer
   *  (it contributed the most of the lines the fix changed; ties all count). Only top links regret. */
  fixes: Array<{ at: number; top: boolean }>;
  /** When its problem reopened in watch, from the run's task. */
  reopened_at: number[];
  role_id: string | null;
  role_handle: string | null;
  /** The check flow it came through ("" outside any). */
  flow: string;
  through: RegretThrough;
  /** Check stations the change passed in its run, by "<flow>/<node id>". */
  checks: string[];
};

export type RegretRow = {
  role_id: string | null;
  role_handle: string | null;
  flow: string;
  through: RegretThrough;
  merged: number;
  settled: number;
  regretted: number;
  partial: number;
  rate: number | null;
};

export type StationRow = { flow: string; node_id: string; label: string; passed: number; settled: number; regretted: number; miss_rate: number | null };

/** `window_links`: how many top links the window was measured from; null when the caller set the window. */
export type RegretSummary = { window_days: number; window_links: number | null; changes: RegretRow[]; stations: StationRow[] };

const start = (c: Pick<RegretChange, "landed_at" | "live_at">) => c.live_at ?? c.landed_at;

/**
 * The window measured from the changes themselves: the lag from a change going live (else landing) to each top fix
 * that traced to it, long enough to cover REGRET_WINDOW_COVERS of them, at most REGRET_WINDOW_MAX_DAYS. With no top
 * link to measure, REGRET_WINDOW_DAYS.
 */
export function windowFromLags(changes: ReadonlyArray<RegretChange>): { days: number; links: number } {
  const lags: number[] = [];
  for (const c of changes) for (const f of c.fixes) if (f.top && f.at > c.landed_at) lags.push(Math.max(0, f.at - start(c)) / DAY_MS);
  if (lags.length === 0) return { days: REGRET_WINDOW_DAYS, links: 0 };
  lags.sort((a, b) => a - b);
  const at = lags[Math.min(lags.length - 1, Math.ceil(lags.length * REGRET_WINDOW_COVERS) - 1)];
  return { days: Math.min(REGRET_WINDOW_MAX_DAYS, Math.max(1, Math.ceil(at))), links: lags.length };
}

/** When a change's window closes: its live time (else its landing) plus the window. */
export const windowEnd = (c: Pick<RegretChange, "landed_at" | "live_at">, windowDays: number) => start(c) + windowDays * DAY_MS;

/**
 * Whether a change came back: a fix it was the top introducer of landed after it
 * and before its window closed, or its problem reopened in that span.
 */
export function regretted(c: RegretChange, windowDays: number): boolean {
  const end = windowEnd(c, windowDays);
  return c.fixes.some((f) => f.top && f.at > c.landed_at && f.at <= end) || c.reopened_at.some((t) => t > c.landed_at && t <= end);
}

/** A change is settled once its window has passed with no regret, or as soon as it is regretted. */
export function settled(c: RegretChange, windowDays: number, now: number): boolean {
  return regretted(c, windowDays) || windowEnd(c, windowDays) <= now;
}

const rate = (settledN: number, regrettedN: number) => (settledN > 0 ? (settledN - regrettedN) / settledN : null);

/**
 * A check station as the miss rate counts it: a station of the check phase
 * that the run passed. The blind judge (`<node>__judge`) passed when the run
 * went out through `<node>__low`; any other check passed when it completed
 * with success.
 */
export function passedChecks(flow: string, nodes: ReadonlyArray<{ node_id: string; status?: string; outcome?: string }>): string[] {
  const done = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.node_id));
  const out: string[] = [];
  for (const n of nodes) {
    const own = n.node_id.split("__").pop() || n.node_id;
    if (own === "judge") {
      const at = n.node_id.slice(0, n.node_id.length - own.length);
      if (done.has(`${at}low`)) out.push(`${flow}/${n.node_id}`);
      continue;
    }
    if (n.status !== "completed" || n.outcome !== "success") continue;
    if (guessPhase(own, "", true) === "check") out.push(`${flow}/${n.node_id}`);
  }
  return out;
}

export function regretSummary(changes: ReadonlyArray<RegretChange>, o: { now: number; windowDays?: number }): RegretSummary {
  const measured = o.windowDays === undefined ? windowFromLags(changes) : null;
  const w = o.windowDays ?? measured!.days;
  const rows = new Map<string, RegretRow>();
  const stations = new Map<string, StationRow>();
  for (const c of changes) {
    const key = `${c.role_id ?? ""}|${c.flow}|${c.through}`;
    const row = rows.get(key) ?? { role_id: c.role_id, role_handle: c.role_handle, flow: c.flow, through: c.through, merged: 0, settled: 0, regretted: 0, partial: 0, rate: null };
    const isSettled = settled(c, w, o.now);
    const isRegretted = regretted(c, w);
    row.merged++;
    if (isSettled) row.settled++; else row.partial++;
    if (isRegretted) row.regretted++;
    rows.set(key, row);
    for (const check of c.checks) {
      const slash = check.indexOf("/");
      const flow = check.slice(0, slash);
      const node = check.slice(slash + 1);
      const s = stations.get(check) ?? { flow, node_id: node, label: stationWords(node), passed: 0, settled: 0, regretted: 0, miss_rate: null };
      s.passed++;
      if (isSettled) s.settled++;
      if (isRegretted) s.regretted++;
      stations.set(check, s);
    }
  }
  const changeRows = [...rows.values()].map((r) => ({ ...r, rate: rate(r.settled, r.regretted) }))
    .sort((a, b) => b.merged - a.merged);
  const stationRows = [...stations.values()].map((s) => ({ ...s, miss_rate: s.settled > 0 ? s.regretted / s.settled : null }))
    .sort((a, b) => b.passed - a.passed);
  return { window_days: w, window_links: measured?.links ?? null, changes: changeRows, stations: stationRows };
}

/** The rate a role's merge setting reads: its line changes over every flow it runs. */
export function roleLineRate(summary: RegretSummary, roleId: string): { settled: number; regretted: number; partial: number; rate: number | null; window_days: number } {
  let settledN = 0, regrettedN = 0, partial = 0;
  for (const r of summary.changes) {
    if (r.role_id !== roleId || r.through !== "line") continue;
    settledN += r.settled; regrettedN += r.regretted; partial += r.partial;
  }
  return { settled: settledN, regretted: regrettedN, partial, rate: rate(settledN, regrettedN), window_days: summary.window_days };
}

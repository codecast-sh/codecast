// The Timeline view's arithmetic (line-workspace.md LW1 Timeline): where a
// problem stands, the time axis every lane shares, occurrences bucketed on it,
// and the ticks under it. Pure; the history it reads is the model's
// (causeHistory.ts), so nothing here re-derives a ship, a deploy or a
// regression, it only places them in time.
import type { CauseHistory, HistoryAttempt, HistoryRegression } from "./causeHistory";
import type { LineIssue } from "./lineModel";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ── where a problem stands ───────────────────────────────────────────────────

export type ProblemState = "regressed" | "fixing" | "watching" | "held" | "open" | "closed";

export const PROBLEM_STATES: ReadonlyArray<ProblemState> = ["regressed", "fixing", "watching", "held", "open", "closed"];

export const PROBLEM_STATE_WORDS: Record<ProblemState, string> = {
  regressed: "Regressed",
  fixing: "Being fixed",
  watching: "Shipped, watching",
  held: "Held",
  open: "Open",
  closed: "Closed",
};

const CLOSED = new Set(["dropped", "closed", "cancelled", "canceled", "wontfix", "done"]);

/**
 * A problem's state from its history: regressed when the newest fix did not
 * hold, being fixed while an attempt runs, shipped and watching until the watch
 * after the newest ship ends, held when it ended quiet (or the cause was closed
 * after the ship), closed when it was closed with no ship, open otherwise.
 */
export function problemState(h: CauseHistory, status: string): ProblemState {
  if (h.regressed) return "regressed";
  if (h.attempts.some((a) => a.live)) return "fixing";
  const ship = h.ships[h.ships.length - 1];
  if (ship) {
    const watch = [...h.watches].reverse().find((w) => w.runId === ship.runId);
    if (watch?.state === "quiet") return "held";
    if (watch?.state === "watching") return "watching";
    return CLOSED.has(status) ? "held" : "watching";
  }
  if (CLOSED.has(status)) return "closed";
  // The newest attempt closed it without a change (dissolved, dropped) and nothing has happened since.
  const latest = h.attempts[h.attempts.length - 1];
  const last = h.occurrences[h.occurrences.length - 1]?.at ?? 0;
  if (latest && (latest.ended === "dissolved" || latest.ended === "dropped") && last <= (latest.end ?? latest.start)) return "closed";
  return "open";
}

/**
 * Everything a problem's row in the list draws, as one string: its words, its
 * state, every occurrence (marked when it came back after a fix), every fix
 * going live and every attempt's mark. Two rows with the same signature draw
 * the same, so the list keeps the row it had across a model rebuild.
 */
export function problemRowSig(issue: LineIssue, state: ProblemState): string {
  const h = issue.history;
  return [
    issue.id, issue.title, issue.ref ?? "", issue.where.text, issue.findings, h.capped ? 1 : 0, state, h.lastActivity,
    h.occurrences.map((o) => (regressionAt(o.at, h.regressions) ? `${o.at}r` : o.at)).join(","),
    h.ships.map((s) => s.liveAt).join(","),
    h.attempts.map((a) => `${a.runId}:${a.n}:${a.live ? 1 : 0}:${attemptTone(a)}:${attemptEndWords(a)}`).join(","),
  ].join("|");
}

/** Where a row's sparkline window ends: the next whole hour, or the next local midnight for day-wide bars, so the bars move once a bucket rather than with the clock. */
export function sparkEnd(now: number, step: number): number {
  const unit = Math.min(step, DAY);
  return alignDown(now, unit) + unit;
}

/** Regressed first, then the newest activity. */
export function sortProblems<T extends { issue: LineIssue; state: ProblemState }>(rows: T[]): T[] {
  return rows.sort((a, b) => Number(b.state === "regressed") - Number(a.state === "regressed") || b.issue.history.lastActivity - a.issue.history.lastActivity);
}

/** How an attempt reads as a mark: its tone in the workspace's palette. */
export type MarkTone = "ok" | "bad" | "warn" | "live" | "person" | "none";
export function attemptTone(a: HistoryAttempt): MarkTone {
  if (a.live) return "live";
  if (a.ended === "shipped") return "ok";
  switch (a.outcome.tone) {
    case "shipped": return "ok";
    case "failed": return "bad";
    case "stuck": return "warn";
    case "waiting": return "person";
    case "live": return "live";
    default: return "none";
  }
}

/** An attempt's end in a few words: "shipped", "dissolved", "failed". */
export function attemptEndWords(a: HistoryAttempt): string {
  if (a.live) return "running";
  if (a.ended) return a.ended;
  if (a.outcome.tone === "failed") return "failed";
  if (a.outcome.tone === "waiting") return "waiting on you";
  if (a.outcome.tone === "stuck") return "stuck";
  return "stopped";
}

// ── occurrences ──────────────────────────────────────────────────────────────

/** The regression an occurrence belongs to: after a fix went live and before the next one did. */
export function regressionAt(at: number, regressions: ReadonlyArray<HistoryRegression>): HistoryRegression | null {
  for (const r of regressions) if (at > r.liveAt && at < (r.until ?? Infinity)) return r;
  return null;
}

/** The first index whose time is >= t in an ascending list. */
export function lowerBound(times: ReadonlyArray<number>, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Counts per bucket of `step` over [t0, t1), on an ascending list of times. */
export function bucketCounts(times: ReadonlyArray<number>, t0: number, t1: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((t1 - t0) / step));
  const out = new Array<number>(n).fill(0);
  for (let i = lowerBound(times, t0); i < times.length && times[i] < t1; i++) out[Math.min(n - 1, Math.floor((times[i] - t0) / step))]++;
  return out;
}

// ── the axis ─────────────────────────────────────────────────────────────────

export type TimeRange = "24h" | "7d" | "30d" | "all";
export const TIME_RANGES: ReadonlyArray<TimeRange> = ["24h", "7d", "30d", "all"];
const RANGE_MS: Record<Exclude<TimeRange, "all">, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

export type Domain = readonly [number, number];

/** Everything a history places in time, so "all" frames all of it. */
function historySpan(h: CauseHistory): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const at = (t: number | null | undefined) => {
    if (t == null || !Number.isFinite(t)) return;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  };
  at(h.occurrences[0]?.at);
  at(h.occurrences[h.occurrences.length - 1]?.at);
  at(h.firstAt);
  for (const a of h.attempts) { at(a.start); at(a.end); }
  for (const s of h.ships) { at(s.at); at(s.merge?.at); }
  for (const d of h.deploys) at(d.at);
  for (const w of h.watches) { at(w.start); at(w.end); }
  return lo === Infinity ? null : [lo, hi];
}

/** The window a range preset shows, ending now; "all" frames the whole history with a little air. */
export function rangeDomain(range: TimeRange, h: CauseHistory, now: number): Domain {
  if (range !== "all") return [now - RANGE_MS[range], now];
  const span = historySpan(h);
  if (!span) return [now - 7 * DAY, now];
  const lo = span[0];
  const hi = Math.max(span[1], now);
  const pad = Math.max(HOUR, (hi - lo) * 0.03);
  return [lo - pad, hi + pad / 3];
}

/** The range that best fits a history on first open: the smallest preset holding its last 2 weeks of activity, else all. */
export function defaultRange(h: CauseHistory, now: number): TimeRange {
  const span = historySpan(h);
  if (!span) return "7d";
  if (span[0] >= now - 7 * DAY) return "7d";
  if (span[0] >= now - 30 * DAY) return "30d";
  return "all";
}

const STEPS = [5 * 60_000, 15 * 60_000, 30 * 60_000, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/** A bucket width that gives at most `target` bars over the span. */
export function bucketStep(span: number, target = 72): number {
  return STEPS.find((s) => span / s <= target) ?? STEPS[STEPS.length - 1];
}

/** The local start of a step-aligned bucket at or before t: whole hours and local midnights read naturally. */
export function alignDown(t: number, step: number): number {
  const d = new Date(t);
  if (step >= DAY) {
    d.setHours(0, 0, 0, 0);
    if (step === 7 * DAY) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  if (step >= HOUR) {
    const hours = step / HOUR;
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() - (d.getHours() % hours));
    return d.getTime();
  }
  return Math.floor(t / step) * step;
}

export type Tick = { at: number; label: string; major: boolean };

const TICK_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });

/** Ticks under the axis: at most `max`, aligned to local hours or midnights; a midnight is major and named by its day. */
export function timeTicks(d: Domain, max: number): Tick[] {
  const span = d[1] - d[0];
  const step = TICK_STEPS.find((s) => span / s <= max) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out: Tick[] = [];
  let t = alignDown(d[0], step);
  if (t < d[0]) t = step >= DAY ? nextDay(t, step) : t + step;
  for (let guard = 0; t <= d[1] && guard < 400; guard++) {
    const midnight = new Date(t).getHours() === 0;
    out.push({ at: t, label: step < DAY && !midnight ? hourLabel(t) : dayLabel(t), major: midnight });
    t = step >= DAY ? nextDay(t, step) : t + step;
  }
  return out;
}

/** The next local midnight `step` days on (DST keeps a day from being exactly 24h). */
function nextDay(t: number, step: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + Math.round(step / DAY));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A bucket's span in words: "Oct 8", "Oct 8, 2 PM to 3 PM", "Oct 6 to Oct 12". */
export function bucketWords(start: number, step: number): string {
  const end = start + step;
  if (step === DAY) return dayLabel(start);
  if (step > DAY) return `${dayLabel(start)} to ${dayLabel(end - 1)}`;
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: step < HOUR ? "2-digit" : undefined });
  return `${dayLabel(start)}, ${time(start)} to ${time(end)}`;
}

/** A moment in words for a hover: "Oct 8, 2:14 PM". */
export const momentWords = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A span in its largest unit: "3h", "2d", "40m". */
export function spanWords(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

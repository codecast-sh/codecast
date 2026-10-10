// The Timeline view's arithmetic (line-workspace.md LW1 Timeline): where a
// problem stands, the time axis every lane shares, occurrences bucketed on it,
// and the ticks under it. Pure; the history it reads is the model's
// (causeHistory.ts), so nothing here re-derives a ship, a deploy or a
// regression, it only places them in time.
import { shortDay } from "@codecast/shared/contracts/causeHistory";
import type { CauseHistory, CloseKind, FixBasis, HistoryAttempt, HistoryClose, HistoryRecurrence, HistoryRegression } from "./causeHistory";
import type { LineIssue } from "./lineModel";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

// ── where a problem stands ───────────────────────────────────────────────────

export type ProblemState = "regressed" | "cameback" | "fixing" | "watching" | "held" | "open" | "closed";

export const PROBLEM_STATES: ReadonlyArray<ProblemState> = ["regressed", "cameback", "fixing", "watching", "held", "open", "closed"];

export const PROBLEM_STATE_WORDS: Record<ProblemState, string> = {
  regressed: "Regressed",
  cameback: "Came back",
  fixing: "Being fixed",
  watching: "Shipped, watching",
  held: "Held",
  open: "Open",
  closed: "Closed",
};

/** The states that mean a close did not hold: listed first. */
const BACK_STATES = new Set<ProblemState>(["regressed", "cameback"]);

const CLOSED = new Set(["dropped", "closed", "cancelled", "canceled", "wontfix", "done"]);

/**
 * A problem's state from its history: regressed when the newest fix did not
 * hold, came back when the newest close without a change (a dissolve, a drop)
 * did not hold, being fixed while an attempt runs, shipped and watching until
 * the watch after the newest ship ends, held when it ended quiet (or the cause
 * was closed after the ship), closed when it was closed and stayed quiet,
 * open otherwise.
 */
export function problemState(h: CauseHistory, status: string): ProblemState {
  if (h.regressed) return "regressed";
  if (h.attempts.some((a) => a.live)) return "fixing";
  if (h.cameBack) return "cameback";
  const close = h.closes[h.closes.length - 1];
  if (close?.kind === "shipped") {
    const watch = [...h.watches].reverse().find((w) => w.runId === close.runId);
    if (watch?.state === "quiet") return "held";
    if (watch?.state === "watching") return "watching";
    return CLOSED.has(status) ? "held" : "watching";
  }
  if (close || CLOSED.has(status)) return "closed";
  return "open";
}

/** What came back after a close at time `at`: the regression after a fix, or the recurrence after a close without one. */
export function comebackAt(at: number, h: Pick<CauseHistory, "regressions" | "recurrences">): HistoryRegression | HistoryRecurrence | null {
  return regressionAt(at, h.regressions) ?? h.recurrences.find((r) => at > r.closedAt && at < (r.until ?? Infinity)) ?? null;
}

/** All the occurrences that came back after any close, in time order. */
export const comebackTimes = (h: CauseHistory): number[] => h.occurrences.filter((o) => comebackAt(o.at, h)).map((o) => o.at);

/** The step a close happened at, as a reader says it: the model's label, else the id in words. */
export const closeStepLabel = (step: string | null, labelOf?: (id: string) => string | undefined): string | null =>
  step ? labelOf?.(step) ?? step.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null;

const CLOSE_VERB: Record<CloseKind, string> = { shipped: "Shipped", dissolved: "Dissolved", dropped: "Dropped" };

/**
 * Where a problem stands, in one line for its row and page header. After a
 * close it says what the newest close did and whether the problem came back:
 * "Dissolved at Investigate Oct 7, came back 5x since". Otherwise the cause's
 * own sentence (LineIssue.where).
 */
export function problemLine(issue: LineIssue, labelOf?: (id: string) => string | undefined, now = Date.now()): string {
  const h = issue.history;
  const live = h.attempts.some((a) => a.live);
  const close = h.closes[h.closes.length - 1];
  if (live || !close) return issue.where.text;
  const back = close.kind === "shipped" ? h.regressions.find((r) => r.afterRunId === close.runId) : h.recurrences.find((r) => r.afterRunId === close.runId);
  if (close.kind === "shipped" && !back) return fixLine(h, close, now);
  const what = closeWords(close, labelOf);
  return back ? `${what}, came back ${back.count === 1 ? "once" : `${back.count}x`} since` : `${what}, quiet since`;
}

const FIX_VERB: Record<FixBasis, string> = { deploy: "deployed", merge: "merged", ship: "shipped" };

/** A fix that went live and has not come back, from the same close and watch problemState reads:
 *  "Fix merged Oct 8 (#2), watching for 6 more days; no recurrence yet". */
function fixLine(h: CauseHistory, close: HistoryClose, now: number): string {
  const ship = h.ships.find((s) => s.runId === close.runId);
  const unapproved = h.attempts.find((a) => a.runId === close.runId)?.unapproved;
  const lead = `Fix ${FIX_VERB[ship?.basis ?? "ship"]} ${shortDay(close.at)} (#${close.n})${unapproved ? " past a card nobody answered" : ""}`;
  const watch = [...h.watches].reverse().find((w) => w.runId === close.runId);
  if (watch?.state === "quiet") return `${lead}, held: the watch ended quiet${watch.end ? ` ${shortDay(watch.end)}` : ""}`;
  if (watch?.state === "watching" && watch.end) {
    const days = Math.max(1, Math.ceil((watch.end - now) / DAY));
    return `${lead}, watching for ${days} more ${days === 1 ? "day" : "days"}; no recurrence yet`;
  }
  return `${lead}; no recurrence since`;
}

/** A close in words, the lead of problemLine: "Dissolved at Investigate Oct 7", "Shipped Oct 3". */
export function closeWords(close: HistoryClose, labelOf?: (id: string) => string | undefined): string {
  const at = close.kind === "shipped" ? null : closeStepLabel(close.step, labelOf);
  return `${CLOSE_VERB[close.kind]}${at ? ` at ${at}` : ""} ${shortDay(close.at)}`;
}

/**
 * The close a problem came back after, when its newest close was a step
 * deciding there was nothing to fix (a dissolve, a drop) and it happened
 * again since: that step's decision on that run was wrong, the loop's
 * learning signal (learning-loop.md LL4). Null while an attempt runs, after a
 * fix (that is a regression, the fix's miss, not a step's), or when it held.
 */
export function cameBackClose(issue: Pick<LineIssue, "history">): HistoryClose | null {
  const h = issue.history;
  if (!h.cameBack || h.attempts.some((a) => a.live)) return null;
  const close = h.closes[h.closes.length - 1];
  return close && close.kind !== "shipped" && close.step ? close : null;
}

/**
 * Everything a problem's row in the list draws, as one string: its words, its
 * state, every occurrence (marked when it came back after a close), every fix
 * going live and every attempt's mark. Two rows with the same signature draw
 * the same, so the list keeps the row it had across a model rebuild.
 */
export function problemRowSig(issue: LineIssue, state: ProblemState): string {
  const h = issue.history;
  return [
    issue.id, issue.title, issue.ref ?? "", issue.where.text, issue.findings, issue.runs.length, h.capped ? 1 : 0, state, h.lastActivity,
    h.occurrences.map((o) => (comebackAt(o.at, h) ? `${o.at}r` : o.at)).join(","),
    h.closes.map((c) => `${c.kind}${c.at}${c.step ?? ""}`).join(","),
    h.attempts.map((a) => `${a.runId}:${a.n}:${a.live ? 1 : 0}:${attemptTone(a)}:${attemptEndWords(a)}`).join(","),
  ].join("|");
}

/** Where a row's sparkline window ends: the next whole hour, or the next local midnight for day-wide bars, so the bars move once a bucket rather than with the clock. */
export function sparkEnd(now: number, step: number): number {
  const unit = Math.min(step, DAY);
  return alignDown(now, unit) + unit;
}

/** Whether a run on the drawn graph has taken the problem; the rest wait in a group of their own. */
export const problemWasRun = (issue: Pick<LineIssue, "runs">) => issue.runs.length > 0;

/** The problems the graph worked first (regressed and came back first among them, then the newest activity), then the ones no run has taken. */
export function sortProblems<T extends { issue: LineIssue; state: ProblemState }>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    Number(problemWasRun(b.issue)) - Number(problemWasRun(a.issue))
    || Number(BACK_STATES.has(b.state)) - Number(BACK_STATES.has(a.state))
    || b.issue.history.lastActivity - a.issue.history.lastActivity);
}

/** How an attempt reads as a mark: its tone in the workspace's palette. "closed" is a close without a change (dissolved, dropped). */
export type MarkTone = "ok" | "bad" | "warn" | "live" | "person" | "closed" | "none";
export function attemptTone(a: HistoryAttempt): MarkTone {
  if (a.live) return "live";
  if (a.ended === "shipped") return a.unapproved ? "warn" : "ok";
  if (a.ended === "dissolved" || a.ended === "dropped") return "closed";
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
  if (a.ended === "shipped" && a.unapproved) return "shipped unapproved";
  if (a.ended) return a.ended;
  if (a.outcome.tone === "failed") return "failed";
  if (a.outcome.tone === "waiting") return "waiting on you";
  if (a.outcome.tone === "stuck") return "stuck";
  return "stopped";
}

/** An attempt's mark in words, for its tooltip: "#2 dissolved at Investigate Oct 7". */
export function attemptMarkWords(a: HistoryAttempt, labelOf?: (id: string) => string | undefined): string {
  const at = a.ended && a.ended !== "shipped" ? closeStepLabel(a.endStep, labelOf) : null;
  return `#${a.n} ${attemptEndWords(a)}${at ? ` at ${at}` : ""} ${shortDay(a.end ?? a.start)}`;
}

/** What each attempt mark's color means, in the order a legend lists them. */
export const MARK_TONE_WORDS: ReadonlyArray<[MarkTone, string]> = [
  ["ok", "shipped"], ["warn", "unapproved or stuck"], ["closed", "closed without a change"], ["bad", "failed"], ["person", "waiting on you"], ["live", "running"], ["none", "stopped"],
];

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

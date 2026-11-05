// The occurrence chart's layout and a check or metric's state over time.
// No React, no store.
import { bucketSeries, GROUP_RULES } from "@codecast/shared/contracts/ingest";
import type { OpsEvent, OpsGroup } from "./opsTypes";
import { DAY, HOUR } from "./issueState";

// ── The occurrence chart ──

export type ChartRange = "24h" | "72h" | "7d" | "30d" | "90d";
export const CHART_RANGES: { key: ChartRange; hours: number }[] = [
  { key: "24h", hours: 24 },
  { key: "7d", hours: 7 * 24 },
  { key: "30d", hours: 30 * 24 },
  { key: "90d", hours: 90 * 24 },
];
export type ChartMark = { x: number; at: number; label: string; tone: "release" | "resolved" | "regressed" | "new" | "fix" | "other" };
export type ChartBar = { at: number; count: number; /** No count was kept this far back. */ unknown?: boolean };
/** Deploys that explain nothing in particular, bunched one per bar width under the x axis. */
export type DeployTick = { x: number; at: number; n: number; label: string };
export type ChartLayout = {
  start: number; hours: number; step: number; bars: ChartBar[]; max: number; total: number;
  /** The total is the group's whole count: the window holds its whole life, so no day before the counts is in doubt. */
  exact: boolean;
  ticks: { x: number; at: number }[]; marks: ChartMark[]; deployTicks: DeployTick[]; lastDeploy: number | null;
  /** Where the newest deploy sits across the window (0..1), placed the way the bars are. */
  lastDeployX: number | null;
};

const MARK_TONE: Record<string, ChartMark["tone"]> = { deploy: "release", resolved: "resolved", regressed: "regressed", new: "new", fix: "fix" };

/**
 * The narrowest range whose window holds the group's last occurrence, so the
 * chart opens on bars rather than an empty grid. A job runs on a schedule, so
 * a day of it is one bar: it opens on a week at least.
 */
export function chartRangeFor(g: Pick<OpsGroup, "last_seen"> & Partial<Pick<OpsGroup, "kind">>, now: number): ChartRange {
  const floor = g.kind === "job" ? 7 * 24 : 0;
  return (CHART_RANGES.find((r) => r.hours >= floor && now - g.last_seen < r.hours * HOUR) ?? CHART_RANGES[CHART_RANGES.length - 1]).key;
}

/**
 * Where the group's counts reach back to: its hourly window, and its daily
 * counts as far as they go (a group that predates them was seeded from its
 * hours on its first write since, so days before that are not known).
 */
export function countsSince(g: Pick<OpsGroup, "days" | "first_seen">, now: number): number {
  const hourFloor = Math.floor(now / HOUR) * HOUR - (GROUP_RULES.bucket_hours - 1) * HOUR;
  const dayFloor = g.days?.length ? Math.floor(g.days[0].day / DAY) * DAY : Infinity;
  return Math.max(g.first_seen - HOUR, Math.min(hourFloor, dayFloor));
}

/** Local midnight of the day holding `t`, `k` days on (negative for back): days are the viewer's calendar days, never UTC's. */
export function localDay(t: number, k = 0): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (k) d.setDate(d.getDate() + k);
  return d.getTime();
}

/**
 * Daily counts for the last `n` local calendar days ending today (today
 * partial), oldest first. A day inside the hourly window counts its hours; a
 * day older than it takes the stored UTC day whose middle falls in it (the
 * server keeps days by UTC), the larger of that and any hours it holds,
 * since either may be ahead of the other by a write. Days before the counts
 * reach back are marked unknown rather than drawn as zero.
 */
export function dailySeries(g: Pick<OpsGroup, "buckets" | "days" | "first_seen">, now: number, n: number): ChartBar[] {
  const hourFloor = Math.floor(now / HOUR) * HOUR - (GROUP_RULES.bucket_hours - 1) * HOUR;
  const edges = Array.from({ length: n + 1 }, (_, i) => localDay(now, i - (n - 1)));
  const dayOf = (t: number) => {
    if (t < edges[0] || t >= edges[n]) return -1;
    let i = 0;
    while (edges[i + 1] <= t) i++;
    return i;
  };
  const fromDays = new Array<number>(n).fill(0);
  const hasDay = new Array<boolean>(n).fill(false);
  for (const d of g.days ?? []) {
    const i = dayOf(Math.floor(d.day / DAY) * DAY + DAY / 2);
    if (i >= 0) {
      fromDays[i] += d.count;
      hasDay[i] = true;
    }
  }
  const fromHours = new Array<number>(n).fill(0);
  for (const b of g.buckets) {
    const i = dayOf(b.hour);
    if (i >= 0) fromHours[i] += b.count;
  }
  const since = countsSince(g, now);
  const out: ChartBar[] = [];
  for (let i = 0; i < n; i++) {
    const at = edges[i];
    const end = edges[i + 1];
    const inHours = at >= hourFloor;
    const count = inHours ? fromHours[i] : Math.max(fromDays[i], fromHours[i]);
    // Not counted: older than both the hours and the oldest stored day, and after the group began.
    const unknown = !inHours && !hasDay[i] && Math.floor((at + end) / 2 / DAY) * DAY + DAY <= since && end > g.first_seen;
    out.push(unknown ? { at, count, unknown: count === 0 } : { at, count });
  }
  return out;
}

/**
 * The page chart: hourly bars up to 72 hours, daily bars past that, ticks,
 * and marks for the group's own transitions, the fix that closed it and the
 * deploys of its source, each placed by time (x in 0..1 across the window).
 * Only a deploy that may explain the chart draws a full line: the one the
 * issue first appeared after, the one before each regression, the one just
 * before a spike. Every other deploy is a tick under the axis, one per bar
 * width with its count. `lastDeploy` is the newest deploy inside the window,
 * so the chart can shade what came after it.
 */
export function layoutChart(
  group: Pick<OpsGroup, "_id" | "short_id" | "source_id" | "buckets"> & Partial<Pick<OpsGroup, "days" | "first_seen" | "last_seen" | "count" | "first_release">>,
  events: OpsEvent[],
  now: number,
  hours: number,
  fix?: { at: number; label: string } | null,
): ChartLayout {
  const daily = hours > GROUP_RULES.bucket_hours;
  const step = daily ? DAY : HOUR;
  const bars: ChartBar[] = daily
    ? dailySeries({ buckets: group.buckets, days: group.days, first_seen: group.first_seen ?? 0 }, now, Math.round(hours / 24))
    : bucketSeries(group.buckets, now, hours).map((count, i, all) => ({ at: Math.floor(now / HOUR) * HOUR - (all.length - 1 - i) * HOUR, count }));
  const end = daily ? localDay(now, 1) : bars[bars.length - 1].at + step;
  const start = bars[0].at;
  const exact = settleUnknownDays(bars, group, start, step);
  const span = end - start;
  // Daily bars are local days (23 or 25 hours across a clock change): a time is placed within its own bar, so it sits over the bar that counts it.
  const x = (at: number) => {
    if (!daily) return Math.min(1, Math.max(0, (at - start) / span));
    if (at <= start) return 0;
    if (at >= end) return 1;
    let i = bars.length - 1;
    while (i > 0 && bars[i].at > at) i--;
    const to = i + 1 < bars.length ? bars[i + 1].at : end;
    return (i + (at - bars[i].at) / (to - bars[i].at)) / bars.length;
  };
  const ticks: ChartLayout["ticks"] = [];
  if (daily) {
    // A tick at the start of every k-th day, counted back from today, so today is always named.
    const k = hours <= 7 * 24 ? 1 : hours <= 30 * 24 ? 7 : 14;
    for (let i = bars.length - 1; i >= 0; i -= k) ticks.unshift({ x: i / bars.length, at: bars[i].at });
  } else {
    // On local hours a multiple of the step (12 AM, 6 AM, ...), or local midnights past a day.
    const stepH = hours <= 24 ? 6 : 24;
    const d = new Date(start);
    d.setMinutes(0, 0, 0);
    while (d.getTime() < start || d.getHours() % stepH) d.setHours(d.getHours() + 1);
    for (; d.getTime() < end; d.setHours(d.getHours() + stepH)) ticks.push({ x: x(d.getTime()), at: d.getTime() });
  }
  const marks: ChartMark[] = [];
  const deploys: { at: number; release: string }[] = [];
  const regressions: number[] = [];
  for (const e of events) {
    if (e.created_at < start || e.created_at > end) continue;
    const mine = e.group_id === group._id || e.data?.group_short_id === group.short_id;
    const deploy = e.kind === "deploy" && e.source_id === group.source_id;
    if (!mine && !deploy) continue;
    if (deploy) {
      deploys.push({ at: e.created_at, release: e.data?.release ?? "deploy" });
      continue;
    }
    const t = e.data?.transition ?? e.kind;
    if (t === "regressed" || e.kind === "error_regressed") regressions.push(e.created_at);
    marks.push({ x: x(e.created_at), at: e.created_at, label: t, tone: MARK_TONE[t] ?? "other" });
  }
  deploys.sort((a, b) => a.at - b.at);
  const lastDeploy = deploys.length ? deploys[deploys.length - 1].at : null;
  const key = keyDeploys(deploys, bars, step, group, regressions);
  // One tick per bucket of bars, centred on it, so two counts never sit on top of each other: a bar each up to 15, wider past that.
  const per = Math.max(1, Math.ceil(bars.length / 15));
  const bucket = (at: number) => Math.floor(Math.min(bars.length - 1, Math.floor(x(at) * bars.length)) / per);
  const deployTicks: DeployTick[] = [];
  for (const [i, d] of deploys.entries()) {
    if (key.has(i)) {
      marks.push({ x: x(d.at), at: d.at, label: d.release, tone: "release" });
      continue;
    }
    const b = bucket(d.at);
    const cx = Math.min(1, ((b + 0.5) * per) / bars.length);
    const prev = deployTicks[deployTicks.length - 1];
    if (prev && bucket(prev.at) === b) deployTicks[deployTicks.length - 1] = { x: cx, at: d.at, n: prev.n + 1, label: d.release };
    else deployTicks.push({ x: cx, at: d.at, n: 1, label: d.release });
  }
  if (fix && fix.at >= start && fix.at <= end) marks.push({ x: x(fix.at), at: fix.at, label: fix.label, tone: "fix" });
  const counts = bars.map((b) => b.count);
  const total = exact ? group.count! : counts.reduce((a, b) => a + b, 0);
  return { start, hours, step, bars, max: Math.max(0, ...counts), total, exact, ticks, marks: thinMarks(marks), deployTicks, lastDeploy, lastDeployX: lastDeploy !== null ? x(lastDeploy) : null };
}

/**
 * When the window holds the group's whole life, its count says how many
 * events the days before the daily counts can hold: none left over makes
 * them zero, and exactly one each for the first and last seen days places
 * those. Returns whether the window's total is the group's count.
 */
function settleUnknownDays(bars: ChartBar[], g: Partial<Pick<OpsGroup, "first_seen" | "last_seen" | "count">>, start: number, step: number): boolean {
  if (g.count === undefined || g.first_seen === undefined || g.first_seen < start) return false;
  const unknown = bars.flatMap((b, i) => (b.unknown ? [i] : []));
  if (!unknown.length) return bars.reduce((a, b) => a + b.count, 0) === g.count;
  const left = g.count - bars.reduce((a, b) => a + (b.unknown ? 0 : b.count), 0);
  const dayOf = (at: number | undefined) => (at === undefined || at < start ? -1 : bars.findLastIndex((b) => b.at <= at));
  const must = [...new Set([dayOf(g.first_seen), dayOf(g.last_seen)])].filter((i) => bars[i]?.unknown);
  if (left > 0 && left !== must.length) return true;
  for (const i of unknown) bars[i] = { at: bars[i].at, count: left > 0 && must.includes(i) ? 1 : 0 };
  return true;
}

/** The deploys worth a full line: the one before first seen, before each regression, and just before a spike. */
function keyDeploys(deploys: { at: number; release: string }[], bars: ChartBar[], step: number, g: Partial<Pick<OpsGroup, "first_seen" | "first_release">>, regressions: number[]): Set<number> {
  const out = new Set<number>();
  const before = (at: number, within = Infinity) => {
    for (let i = deploys.length - 1; i >= 0; i--) if (deploys[i].at <= at) return at - deploys[i].at <= within ? i : -1;
    return -1;
  };
  const first = g.first_release ? deploys.findIndex((d) => d.release === g.first_release) : -1;
  const add = (i: number) => i >= 0 && out.add(i);
  add(first >= 0 ? first : g.first_seen !== undefined ? before(g.first_seen) : -1);
  for (const at of regressions) add(before(at));
  for (const [i, b] of bars.entries()) {
    if (b.unknown || b.count < 3) continue;
    const prior = bars.slice(Math.max(0, i - 3), i).filter((p) => !p.unknown);
    const usual = prior.length ? prior.reduce((a, p) => a + p.count, 0) / prior.length : 0;
    if (b.count >= 3 * Math.max(1, usual) && (bars[i - 1]?.count ?? 0) < b.count / 2) add(before(b.at + step, 2 * step));
  }
  return out;
}

/**
 * Marks close enough to collide keep one label: a deploy beside a
 * transition gives way to it, and of two deploys the newer names the spot.
 * The dropped ones stay as lines without a label.
 */
export function thinMarks(marks: ChartMark[], minGap = 0.09): ChartMark[] {
  const sorted = [...marks].sort((a, b) => a.x - b.x || a.at - b.at);
  const rank = (m: ChartMark) => (m.tone === "release" ? 0 : 1);
  let lastLabeled: ChartMark | null = null;
  const out: ChartMark[] = [];
  for (const m of sorted) {
    if (lastLabeled && m.x - lastLabeled.x < minGap) {
      if (rank(m) >= rank(lastLabeled)) {
        out[out.indexOf(lastLabeled)] = { ...lastLabeled, label: "" };
        lastLabeled = m;
        out.push(m);
      } else out.push({ ...m, label: "" });
      continue;
    }
    lastLabeled = m;
    out.push(m);
  }
  return out;
}

/**
 * The y axis for a peak: a round top at or above it and its half when that
 * is a whole number, each value once. A peak of 1 reads 1 and 0, never 1, 1, 0.
 */
export function yTicks(max: number): { top: number; ticks: { value: number; y: number }[] } {
  const peak = Math.max(1, Math.ceil(max));
  let top = peak;
  if (peak > 5) {
    const mag = 10 ** Math.floor(Math.log10(peak));
    top = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((t) => t >= peak && Number.isInteger(t)) ?? 10 * mag);
  }
  const values = [top, top / 2, 0].filter((v, i, all) => Number.isInteger(v) && all.indexOf(v) === i);
  return { top, ticks: values.map((value) => ({ value, y: 1 - value / top })) };
}

/**
 * An issue's whole life on one axis, from first seen (or 90 days back) to
 * now: its own transitions and its source's releases, each placed by time.
 * What the hourly chart cannot show: where it began, in which release, and
 * each time it was resolved and came back.
 */
export function lifeMarks(group: Pick<OpsGroup, "_id" | "short_id" | "source_id" | "first_seen" | "first_release">, events: OpsEvent[], now: number, maxDays = 90): { start: number; clipped: boolean; marks: ChartMark[] } {
  const floor = now - maxDays * 24 * HOUR;
  const start = Math.max(group.first_seen, floor);
  const span = Math.max(HOUR, now - start);
  const x = (at: number) => Math.min(1, Math.max(0, (at - start) / span));
  const marks: ChartMark[] = [];
  for (const e of events) {
    if (e.created_at < start || e.created_at > now) continue;
    const mine = e.group_id === group._id || e.data?.group_short_id === group.short_id;
    const deploy = e.kind === "deploy" && e.source_id === group.source_id;
    if (!mine && !deploy) continue;
    const t = deploy ? "deploy" : e.data?.transition ?? e.kind;
    if (t === "new" || e.kind === "error_new") continue;
    marks.push({ x: x(e.created_at), at: e.created_at, label: deploy ? e.data?.release ?? "deploy" : t, tone: MARK_TONE[t] ?? "other" });
  }
  marks.unshift({ x: 0, at: group.first_seen, label: group.first_release ? `first seen in ${group.first_release}` : "first seen", tone: "new" });
  return { start, clipped: group.first_seen < floor, marks: marks.sort((a, b) => a.at - b.at) };
}

// ── A check or metric's state over time ──

export type HealthState = "failing" | "passing" | "none";
export type StateSpan = { from: number; to: number; state: HealthState };

const FAILING_TRANSITIONS = new Set(["check_failed", "metric_alert", "job_failed", "new", "regressed", "spike"]);
const PASSING_TRANSITIONS = new Set(["check_recovered", "metric_recovered", "resolved"]);

/** The state a transition row leaves its group in, or null for a row that moves nothing (a deploy). */
export function transitionState(e: Pick<OpsEvent, "kind" | "data">): Exclude<HealthState, "none"> | null {
  const t = e.data?.transition ?? e.kind;
  if (FAILING_TRANSITIONS.has(t)) return "failing";
  if (PASSING_TRANSITIONS.has(t)) return "passing";
  if (e.kind === "error_new" || e.kind === "error_regressed") return "failing";
  return null;
}

/** Whether a check or metric group is passing right now, by its own reading. */
export function currentHealth(g: Pick<OpsGroup, "status" | "meta">): Exclude<HealthState, "none"> {
  return g.meta?.ok === true || g.status === "resolved" ? "passing" : "failing";
}

export type HealthStrip = {
  start: number;
  end: number;
  spans: StateSpan[];
  /** When the current failing run began; null while passing. */
  failingSince: number | null;
  /** The newest flip to passing that this device has read, if any: when the current passing run began. */
  lastPass: number | null;
  /**
   * While failing, the last moment it was green: the last passing reading the
   * group recorded (meta.last_ok_at), else the flip that ended the passing
   * run before this failure. Null when no pass is on record. While passing, now.
   */
  lastGreen: number | null;
  /** Failing runs that show inside the window, one carried in from before it included. */
  failures: number;
  /** Share of the known window spent failing, 0..1. */
  failingShare: number;
};

/**
 * A check or metric's failing and passing spans over [end - hours, end],
 * from its transition rows and its current reading. Before the group was
 * first seen there is no state; before the oldest flip read, the state is
 * the one that flip left.
 */
export function healthStrip(g: Pick<OpsGroup, "_id" | "short_id" | "first_seen" | "status" | "meta">, events: OpsEvent[], now: number, hours: number): HealthStrip {
  const end = now;
  const start = end - hours * HOUR;
  const flips = events
    .filter((e) => e.group_id === g._id || e.data?.group_short_id === g.short_id)
    .map((e) => ({ at: e.created_at, state: transitionState(e) }))
    .filter((f): f is { at: number; state: "failing" | "passing" } => f.state !== null && f.at <= end)
    .sort((a, b) => a.at - b.at);
  const current = currentHealth(g);
  const stateAt = (t: number): HealthState => {
    if (t < g.first_seen) return "none";
    let last: (typeof flips)[number] | undefined;
    for (const f of flips) if (f.at <= t) last = f;
    if (last) return last.state;
    if (flips.length) return flips[0].state === "failing" ? "passing" : "failing";
    return current;
  };
  const cuts = [start, ...(g.first_seen > start && g.first_seen < end ? [g.first_seen] : []), ...flips.map((f) => f.at).filter((at) => at > start && at < end), end];
  const spans: StateSpan[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i];
    const to = cuts[i + 1];
    if (to <= from) continue;
    // The newest span is the group's own reading, whatever the last flip read here said.
    const state = i === cuts.length - 2 && to === end && stateAt(from) !== "none" ? current : stateAt(from);
    const prev = spans[spans.length - 1];
    if (prev && prev.state === state) prev.to = to;
    else spans.push({ from, to, state });
  }
  let failingSince: number | null = null;
  if (current === "failing") {
    const lastPassFlip = [...flips].reverse().find((f) => f.state === "passing");
    const firstFail = flips.find((f) => f.state === "failing" && (!lastPassFlip || f.at > lastPassFlip.at));
    failingSince = firstFail?.at ?? (lastPassFlip ? null : g.first_seen);
  }
  const lastPass = [...flips].reverse().find((f) => f.state === "passing")?.at ?? null;
  let lastGreen: number | null = current === "passing" ? end : null;
  if (current === "failing") {
    const okAt = g.meta?.last_ok_at;
    const flippedFromGreen = failingSince !== null && failingSince > g.first_seen && stateAt(failingSince - 1) === "passing";
    lastGreen = okAt !== undefined && (failingSince === null || okAt <= failingSince) ? okAt : flippedFromGreen ? failingSince : null;
  }
  const known = spans.filter((s) => s.state !== "none").reduce((a, s) => a + (s.to - s.from), 0);
  const failingMs = spans.filter((s) => s.state === "failing").reduce((a, s) => a + (s.to - s.from), 0);
  return {
    start,
    end,
    spans,
    failingSince,
    lastPass,
    lastGreen,
    failures: spans.filter((s) => s.state === "failing").length,
    failingShare: known ? failingMs / known : 0,
  };
}

/**
 * Where a state strip's axis labels go: on whole hours across a day, on
 * midnights across a week, every few midnights past it, so each label sits
 * at the moment it names and the gaps between them are equal.
 */
export function stripTicks(start: number, end: number, hours: number): { x: number; at: number; day: boolean }[] {
  const span = end - start;
  const day = hours > 24;
  const stepH = hours <= 24 ? 6 : hours <= 24 * 7 ? 24 : hours <= 24 * 30 ? 24 * 7 : 24 * 15;
  const first = new Date(start);
  if (day) first.setHours(24, 0, 0, 0);
  else first.setHours(first.getHours() + 1, 0, 0, 0);
  // Hour ticks fall on multiples of the step so a day reads 0, 6, 12, 18.
  if (!day) while (first.getHours() % stepH) first.setHours(first.getHours() + 1);
  const out: { x: number; at: number; day: boolean }[] = [];
  for (let d = new Date(first); d.getTime() < end; ) {
    const at = d.getTime();
    const x = (at - start) / span;
    // A label hard against "now" would collide with it.
    if (x < 0.94) out.push({ x, at, day });
    if (day) d.setDate(d.getDate() + stepH / 24);
    else d.setHours(d.getHours() + stepH);
  }
  return out;
}

// The top of the Problems page (line-journeys.md LJ8.2): three figures that
// say whether the product is getting better, and the trend under them. One
// window (24h, 7d, 30d) shared by the figures, the chart and the table's
// Findings column; findings per bucket stacked by problem, the five busiest
// in colour and the rest as one band; and a mark where a fix was merged or
// reached production. Pure.
import { alignDown, bucketCounts, DAY, HOUR, lowerBound, neverShipped } from "./timeline";
import type { LineIssue } from "./lineModel";
import type { ProblemStand } from "./problemStatus";

export type OverviewRange = "24h" | "7d" | "30d";
export const OVERVIEW_RANGES: ReadonlyArray<OverviewRange> = ["24h", "7d", "30d"];
export const DEFAULT_RANGE: OverviewRange = "7d";
export const isOverviewRange = (v: string | null | undefined): v is OverviewRange => !!v && (OVERVIEW_RANGES as readonly string[]).includes(v);
const SPAN: Record<OverviewRange, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
/** A bar is a day, or an hour of the last day. */
const STEP: Record<OverviewRange, number> = { "24h": HOUR, "7d": DAY, "30d": DAY };
/** The window before, as the first figure names it. */
export const BEFORE_WORDS: Record<OverviewRange, string> = { "24h": "the day before", "7d": "the week before", "30d": "the 30 days before" };

/** The window every mark of the page shares: [d0, d1) in buckets of `step`, ending at the next whole bucket after now. */
export type OverviewWindow = { range: OverviewRange; d0: number; d1: number; step: number; n: number };

export function overviewWindow(range: OverviewRange, now: number): OverviewWindow {
  const step = STEP[range];
  // Aligned to the bucket, so the bars move once a bucket rather than with the clock.
  const d1 = alignDown(now, step) + step;
  const d0 = alignDown(d1 - SPAN[range], step);
  return { range, d0, d1, step, n: Math.round((d1 - d0) / step) };
}

/** The problems that take a colour of their own, busiest first; every other problem is one neutral band. */
export const TOP_PROBLEMS = 5;

export type OverviewProblem = { id: string; ref: string | null; title: string; n: number; slot: number };
export type OverviewBucket = { i: number; from: number; to: number; total: number; byTop: number[]; other: number };
/** A fix on the axis: merged, or carried to production by a deploy. */
export type OverviewMarker = { at: number; kind: "production" | "merged"; problemId: string; ref: string | null; title: string };

export type Overview = {
  win: OverviewWindow;
  buckets: OverviewBucket[];
  top: OverviewProblem[];
  /** Findings in the window outside the top problems, and how many problems they belong to. */
  other: { n: number; problems: number };
  total: number;
  max: number;
  markers: OverviewMarker[];
};

type IssueLike = Pick<LineIssue, "id" | "ref" | "title" | "history">;

const occTimes = (i: IssueLike) => i.history.occurrences.map((o) => o.at);

/** Findings of one problem inside [from, to). */
export function countIn(i: IssueLike, from: number, to: number): number {
  const t = occTimes(i);
  return lowerBound(t, to) - lowerBound(t, from);
}

/** The whole chart from the problems in view: per bucket the findings of each top problem and the rest together, and every fix that went out in the window. */
export function buildOverview(issues: ReadonlyArray<IssueLike>, win: OverviewWindow): Overview {
  const counted = issues.map((i) => ({ i, n: countIn(i, win.d0, win.d1) })).filter((x) => x.n > 0);
  counted.sort((a, b) => b.n - a.n || (a.i.ref ?? a.i.id).localeCompare(b.i.ref ?? b.i.id));
  const top: OverviewProblem[] = counted.slice(0, TOP_PROBLEMS).map((x, slot) => ({ id: x.i.id, ref: x.i.ref ?? null, title: x.i.title, n: x.n, slot }));
  const buckets: OverviewBucket[] = Array.from({ length: win.n }, (_, i) => ({ i, from: win.d0 + i * win.step, to: win.d0 + (i + 1) * win.step, total: 0, byTop: new Array(top.length).fill(0), other: 0 }));
  let otherN = 0;
  for (const { i } of counted) {
    const slot = top.findIndex((t) => t.id === i.id);
    bucketCounts(occTimes(i), win.d0, win.d1, win.step).forEach((c, k) => {
      if (!c || !buckets[k]) return;
      buckets[k].total += c;
      if (slot >= 0) buckets[k].byTop[slot] += c;
      else { buckets[k].other += c; otherN += c; }
    });
  }
  const markers: OverviewMarker[] = [];
  for (const i of issues) {
    const h = i.history;
    for (const s of h.ships) {
      const at = s.deploys[0]?.at ?? s.merge?.at ?? s.at;
      if (at < win.d0 || at >= win.d1) continue;
      // A run that went past an unanswered decision with nothing merged or deployed shipped nothing: no mark.
      if (neverShipped(h.attempts.find((a) => a.runId === s.runId), s)) continue;
      markers.push({ at, kind: s.deploys.length ? "production" : "merged", problemId: i.id, ref: i.ref ?? null, title: i.title });
    }
  }
  markers.sort((a, b) => a.at - b.at);
  return {
    win, buckets, top,
    other: { n: otherN, problems: counted.length - top.length },
    total: buckets.reduce((n, b) => n + b.total, 0),
    max: Math.max(1, ...buckets.map((b) => b.total)),
    markers,
  };
}

// ── the three figures ────────────────────────────────────────────────────────

export type ProblemFigures = {
  /** Findings in the window, and in the window before; `before` is null when any problem's series does not reach that far back. */
  findings: number;
  before: number | null;
  /** Fixes in production, and how many of them have had no finding since. */
  inProduction: number;
  quiet: number;
  /** Fixes merged that no production deploy is known to carry. */
  merged: number;
};

/** The figures over the rows in view. Each count is the rows its filter opens (status=shipped, +quiet=1, status=merged). */
export function problemFigures(rows: ReadonlyArray<{ stand: Pick<ProblemStand, "status" | "quiet">; inWindow: number; before: number | null }>): ProblemFigures {
  let findings = 0, before: number | null = 0, inProduction = 0, quiet = 0, merged = 0;
  for (const r of rows) {
    findings += r.inWindow;
    before = before == null || r.before == null ? null : before + r.before;
    if (r.stand.status === "shipped") { inProduction++; if (r.stand.quiet) quiet++; }
    if (r.stand.status === "merged") merged++;
  }
  return { findings, before, inProduction, quiet, merged };
}

/** The first figure's second line: "18% fewer than the week before", or with none in the window the count before ("12 the
 *  week before"). Null when there is nothing to compare with. */
export function changeWords(f: Pick<ProblemFigures, "findings" | "before">, range: OverviewRange): { words: string; tone: "better" | "worse" | "same" } | null {
  if (f.before == null) return null;
  const than = BEFORE_WORDS[range];
  if (f.before === 0) return f.findings ? { words: `none ${than}`, tone: "worse" } : null;
  // None in the window is its own state, not "100% fewer": the count before is what a reader can weigh.
  if (f.findings === 0) return { words: `${f.before} ${than}`, tone: "better" };
  if (f.findings === f.before) return { words: `same as ${than}`, tone: "same" };
  const pct = Math.max(1, Math.round((Math.abs(f.findings - f.before) / f.before) * 100));
  return f.findings < f.before ? { words: `${pct}% fewer than ${than}`, tone: "better" } : { words: `${pct}% more than ${than}`, tone: "worse" };
}

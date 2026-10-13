// The top of the Problems page (line-journeys.md LJ8.2): the figures that say
// whether the product is getting better, and the trend under them. One window
// (24h, 7d, 30d) shared by the figures, the chart and the table's Findings
// column; findings per bucket, each bar a day (or hour) a person picks to list
// its problems; and a mark where a fix was merged or reached production. Pure.
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

/** The problems a bar's tooltip names, busiest that day first; the rest are one count. */
export const TIP_PROBLEMS = 3;

export type OverviewProblem = { id: string; ref: string | null; title: string; name?: string | null; n: number };
/** One bar: its findings, the busiest problems in it and how many findings the rest hold. */
export type OverviewBucket = { i: number; from: number; to: number; total: number; top: OverviewProblem[]; rest: number };
/** A fix on the axis: merged, or carried to production by a deploy. */
export type OverviewMarker = { at: number; kind: "production" | "merged"; problemId: string; ref: string | null; title: string; name?: string | null };

export type Overview = {
  win: OverviewWindow;
  buckets: OverviewBucket[];
  total: number;
  max: number;
  markers: OverviewMarker[];
};

type IssueLike = Pick<LineIssue, "id" | "ref" | "title" | "history"> & { name?: string | null };

const occTimes = (i: IssueLike) => i.history.occurrences.map((o) => o.at);

/** Findings of one problem inside [from, to). */
export function countIn(i: IssueLike, from: number, to: number): number {
  const t = occTimes(i);
  return lowerBound(t, to) - lowerBound(t, from);
}

/** The whole chart from the problems in view: per bucket its findings and the problems holding the most of them, and
 *  every fix that went out in the window. A bar is a day to pick, so it is one mark; who is in it is its tooltip's. */
export function buildOverview(issues: ReadonlyArray<IssueLike>, win: OverviewWindow): Overview {
  const per: OverviewProblem[][] = Array.from({ length: win.n }, () => []);
  for (const i of issues) {
    if (!countIn(i, win.d0, win.d1)) continue;
    bucketCounts(occTimes(i), win.d0, win.d1, win.step).forEach((c, k) => { if (c && per[k]) per[k].push({ id: i.id, ref: i.ref ?? null, title: i.title, name: i.name, n: c }); });
  }
  const buckets: OverviewBucket[] = per.map((ps, i) => {
    ps.sort((a, b) => b.n - a.n || (a.ref ?? a.id).localeCompare(b.ref ?? b.id));
    const total = ps.reduce((n, p) => n + p.n, 0);
    const top = ps.slice(0, TIP_PROBLEMS);
    return { i, from: win.d0 + i * win.step, to: win.d0 + (i + 1) * win.step, total, top, rest: total - top.reduce((n, p) => n + p.n, 0) };
  });
  const markers: OverviewMarker[] = [];
  for (const i of issues) {
    const h = i.history;
    for (const s of h.ships) {
      const at = s.deploys[0]?.at ?? s.merge?.at ?? s.at;
      if (at < win.d0 || at >= win.d1) continue;
      // A run that went past an unanswered decision with nothing merged or deployed shipped nothing: no mark.
      if (neverShipped(h.attempts.find((a) => a.runId === s.runId), s)) continue;
      markers.push({ at, kind: s.deploys.length ? "production" : "merged", problemId: i.id, ref: i.ref ?? null, title: i.title, name: i.name });
    }
  }
  markers.sort((a, b) => a.at - b.at);
  return { win, buckets, total: buckets.reduce((n, b) => n + b.total, 0), max: Math.max(1, ...buckets.map((b) => b.total)), markers };
}

/** The bucket a picked time names when it starts a bucket of this window; else null (a link made under another window). */
export function bucketAt(win: OverviewWindow, at: number | null): { from: number; to: number } | null {
  if (at == null || !Number.isFinite(at) || at < win.d0 || at >= win.d1 || (at - win.d0) % win.step !== 0) return null;
  return { from: at, to: at + win.step };
}

// ── the three figures ────────────────────────────────────────────────────────

export type ProblemFigures = {
  /** Findings in the window, and in the window before; `before` is null when any problem's series does not reach that far back. */
  findings: number;
  before: number | null;
  /** Fixes in production, and how many of them have had no finding since. */
  inProduction: number;
  quiet: number;
};

/** The figures over the rows in view. The fixes count the rows their filters open (status=shipped, +quiet=1). Findings
 *  count only problems with a series (problemTable `series`): one in no project reads whatever recent findings the
 *  store holds on this load, which differ from load to load. */
export function problemFigures(rows: ReadonlyArray<{ stand: Pick<ProblemStand, "status" | "quiet">; inWindow: number; before: number | null; series?: boolean }>): ProblemFigures {
  let findings = 0, before: number | null = 0, inProduction = 0, quiet = 0;
  for (const r of rows) {
    if (r.series !== false) {
      findings += r.inWindow;
      before = before == null || r.before == null ? null : before + r.before;
    }
    if (r.stand.status === "shipped") { inProduction++; if (r.stand.quiet) quiet++; }
  }
  return { findings, before, inProduction, quiet };
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

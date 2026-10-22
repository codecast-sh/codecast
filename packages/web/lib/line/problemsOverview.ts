// The top of the Problems page (line-journeys.md LJ8.2): the figures that say
// whether the product is getting better, and the trend under them. One window
// (24h, 7d, 30d) shared by the figures, the chart and the table's Findings
// column; findings per bucket, each bar a day (or hour) a person picks to list
// its problems; and a mark where a fix was merged or reached production. Pure.
import { shortDay } from "@codecast/shared/contracts/causeHistory";
import { alignDown, bucketCounts, comebackAt, DAY, HOUR, lowerBound, neverShipped, notDeployed } from "./timeline";
import type { CauseHistory } from "./causeHistory";
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

// ── a row's strip ────────────────────────────────────────────────────────────

/** Where a row's problem stands against its newest fix: it came back after a close (red), the fix is live and nothing
 *  came back (green), the fix is merged and no deploy carried it (amber), or no fix ever went out. */
export type StripState = "back" | "quiet" | "unlive" | "nofix";
/** One row's strip over the page's window: its findings per bucket (`back` of them after a close that did not hold), its
 *  newest fix where it went live (`at` may fall before the window: the whole strip is after it then), and the closes
 *  without a change inside the window. */
export type RowStrip = {
  d0: number; d1: number; step: number; n: number;
  bars: Array<{ i: number; n: number; back: number }>;
  max: number;
  fix: { at: number; kind: "production" | "merged" | "unlive" } | null;
  closes: number[];
  state: StripState;
};

/** A strip's bucket: finer than the trend's bars, so a day's findings before and after a deploy that day fall apart. */
const STRIP_STEP: Record<OverviewRange, number> = { "24h": HOUR, "7d": 6 * HOUR, "30d": DAY };

/** The newest fix that went out (never one that only went past an unanswered card), with when it went live. */
export function newestFix(h: Pick<CauseHistory, "ships" | "attempts" | "coverage">): RowStrip["fix"] {
  let best: RowStrip["fix"] = null;
  for (const s of h.ships) {
    if (neverShipped(h.attempts.find((a) => a.runId === s.runId), s)) continue;
    if (best && s.liveAt < best.at) continue;
    best = { at: s.liveAt, kind: s.deploys.length ? "production" : notDeployed(s.runId, h) ? "unlive" : "merged" };
  }
  return best;
}

export function rowStrip(h: CauseHistory, win: OverviewWindow): RowStrip {
  const step = STRIP_STEP[win.range];
  const { d0, d1 } = win;
  const n = Math.max(1, Math.round((d1 - d0) / step));
  const times = h.occurrences.map((o) => o.at);
  const all = bucketCounts(times, d0, d1, step);
  const isBack = (at: number) => !!comebackAt(at, h);
  const back = bucketCounts(h.occurrences.filter((o) => isBack(o.at)).map((o) => o.at), d0, d1, step);
  const bars = all.flatMap((c, i) => (c ? [{ i, n: c, back: back[i] }] : []));
  const fix = newestFix(h);
  const closes = h.closes.filter((c) => c.kind !== "shipped" && c.at >= d0 && c.at < d1).map((c) => c.at);
  const state: StripState = h.regressed || h.cameBack ? "back" : fix ? (fix.kind === "unlive" ? "unlive" : "quiet") : "nofix";
  return { d0, d1, step, n, bars, max: Math.max(1, ...all), fix, closes, state };
}

/** A strip's hover line: its findings in the window, and its fix with what came after it ("Fix deployed Oct 8 · 3 since"). */
export function stripWords(s: RowStrip, h: Pick<CauseHistory, "occurrences">, range: OverviewRange): string {
  const inWin = s.bars.reduce((t, b) => t + b.n, 0);
  const lead = `${inWin} ${inWin === 1 ? "finding" : "findings"} in ${range}`;
  if (!s.fix) return s.state === "back" ? `${lead} · came back after a close` : `${lead} · no fix yet`;
  const since = h.occurrences.filter((o) => o.at > s.fix!.at).length;
  const verb = s.fix.kind === "production" ? "deployed" : s.fix.kind === "unlive" ? "merged, not deployed" : "merged";
  return `${lead} · fix ${verb} ${shortDay(s.fix.at)} · ${since} since`;
}

/** What a row's strip draws, as one string: a model rebuild keeps the row while it holds. */
export function stripSig(h: CauseHistory): string {
  const o = h.occurrences;
  return [o.length, o[0]?.at ?? 0, o[o.length - 1]?.at ?? 0, h.regressed ? 1 : 0, h.cameBack ? 1 : 0, h.regressions.length, h.recurrences.length,
    h.ships.map((s) => `${s.runId}:${s.liveAt}:${s.deploys.length}`).join(","), h.closes.map((c) => `${c.kind}${c.at}`).join(",")].join(";");
}

// ── the three figures ────────────────────────────────────────────────────────

export type ProblemFigures = {
  /** Findings in the window, and in the window before; `before` is null when any problem's series does not reach that far back. */
  findings: number;
  before: number | null;
  /** Problems with a finding in the window, and in the window before (null as `before` is); `fresh`: those whose first
   *  finding ever is in the window. The page leads with these: a finder that runs ten times as much files ten times the
   *  findings on the same problems, so the raw count measures the finders as much as the product. */
  problems: number;
  problemsBefore: number | null;
  fresh: number;
  /** Fixes in production, and how many of them have had no finding since. */
  inProduction: number;
  quiet: number;
  /** Findings in the window's older and newer halves (by bucket), and where the newer half starts: what the bars show
   *  inside the window, which a comparison with the window before can contradict. */
  halves?: { early: number; late: number; earlyN: number; lateN: number; at: number; step: number };
};

/** The figures over the rows in view. The fixes count the rows their filters open (status=shipped, +quiet=1). Findings
 *  count only problems with a series (problemTable `series`): one in no project reads whatever recent findings the
 *  store holds on this load, which differ from load to load. */
type FigureRow = { stand: Pick<ProblemStand, "status" | "quiet">; inWindow: number; before: number | null; series?: boolean; issue?: { history: { occurrences: ReadonlyArray<{ at: number }> } }; twins?: ReadonlyArray<FigureRow> };
/** `win`: the window, so a problem whose first finding falls in it counts as new. A row's folded twins add their
 *  findings, never a problem: a twin is its older problem under another id. */
export function problemFigures(rows: ReadonlyArray<FigureRow>, win?: Pick<OverviewWindow, "d0" | "d1"> & Partial<Pick<OverviewWindow, "step" | "n">>): ProblemFigures {
  let findings = 0, before: number | null = 0, inProduction = 0, quiet = 0, problems = 0, problemsBefore: number | null = 0, fresh = 0;
  const half = win?.step && win.n && win.n >= 2 ? { earlyN: Math.floor(win.n / 2), lateN: win.n - Math.floor(win.n / 2), at: win.d0 + Math.floor(win.n / 2) * win.step, early: 0, late: 0, step: win.step } : null;
  for (const r of rows) {
    const all = [r, ...(r.twins ?? [])].filter((x) => x.series !== false);
    if (all.length) {
      const n = all.reduce((t, x) => t + x.inWindow, 0);
      findings += n;
      const b = all.some((x) => x.before == null) ? null : all.reduce((t, x) => t + (x.before ?? 0), 0);
      before = before == null || b == null ? null : before + b;
      if (n > 0) problems++;
      problemsBefore = problemsBefore == null || b == null ? null : problemsBefore + (b > 0 ? 1 : 0);
      const first = Math.min(...all.map((x) => x.issue?.history.occurrences[0]?.at ?? Infinity));
      if (n > 0 && win && first >= win.d0 && first < win.d1) fresh++;
      if (half && win) for (const x of all) for (const o of x.issue?.history.occurrences ?? []) {
        if (o.at >= win.d0 && o.at < win.d1) { if (o.at < half.at) half.early++; else half.late++; }
      }
    }
    if (r.stand.status === "shipped") { inProduction++; if (r.stand.quiet) quiet++; }
  }
  return { findings, before, problems, problemsBefore, fresh, inProduction, quiet, ...(half ? { halves: half } : {}) };
}

// ── what the finders did ─────────────────────────────────────────────────────

/** The lead's comparison with the window before (problems found then and now), or what stands in for it. Problem
 *  counts compare only when the finders filed within 2x as much in both windows: a finder that ran ten times as much
 *  opens more problems too, and a percentage would credit or blame the product for it. Then the words say how
 *  differently the finders filed, in no tone. Null when the series do not reach back. */
export function leadChange(f: Pick<ProblemFigures, "problems" | "problemsBefore" | "findings" | "before" | "halves">, range: OverviewRange): { words: string; tone: "better" | "worse" | "same" } | null {
  if (f.before == null || f.problemsBefore == null) return null;
  const fair = f.before * 2 >= f.findings && f.findings * 2 >= f.before;
  if (fair) return changeWords({ findings: f.problems, before: f.problemsBefore }, range);
  // The finders filed far more or less than the window before, and inside the window their daily rate moved 2x or more
  // the other way: the bars show the newer move, so the words lead with it ("2.5x more than the week before" over bars
  // that fall 10x read as a lie).
  const h = f.halves;
  if (h && h.early + h.late > 0) {
    const a = h.early / h.earlyN, b = h.late / h.lateN;
    const ratio = a && b ? Math.max(a, b) / Math.min(a, b) : Infinity;
    if (ratio >= 2 && (b > a) !== (f.findings > f.before)) {
      const from = bucketStart(h.at, h.step);
      if (!b) return { words: `finders filed none from ${from} on`, tone: "same" };
      if (!a) return { words: `finders filed none before ${from}`, tone: "same" };
      return { words: `finders filed ${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}x ${b > a ? "more" : "fewer"} a ${h.step < DAY ? "hour" : "day"} from ${from} on`, tone: "same" };
    }
  }
  const than = BEFORE_WORDS[range];
  if (f.before === 0) return { words: `finders filed none ${than}`, tone: "same" };
  if (f.findings === 0) return { words: `none found; ${f.before} findings ${than}`, tone: "same" };
  const x = f.findings > f.before ? f.findings / f.before : f.before / f.findings;
  return { words: `finders filed ${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}x ${f.findings > f.before ? "more" : "fewer"} than ${than}`, tone: "same" };
}

/** Where a bucket starts, as the lead names it: "Oct 10", or "3 PM" for an hour. */
function bucketStart(at: number, step: number): string {
  const d = new Date(at);
  return step < DAY ? d.toLocaleTimeString(undefined, { hour: "numeric" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A finder that stopped filing, or filed far less, partway through the window: the bars from `from` on (bucket
 *  index) are low because it filed little, not because the product got better. `key` opens it (Line ?source=). */
export type FinderShift = { key: string; source: string; judge: string | null; kind: "stopped" | "less"; from: number; before: number; after: number; beforeDays: number; lastAt: number | null };

/** Where a finding sits on the axis: the moment it is about, else when it was filed (sourcesView findingAt). */
const atOf = (s: { created_at: number; observed_at?: number | null }) => s.observed_at || s.created_at;

/**
 * The finders whose own volume moved enough to move the chart: one that filed nothing on the last two or more days
 * after filing on earlier ones, or one whose daily count fell to a fifth or less of what it was. Only those that held
 * a real share of the window's findings, busiest loss first, at most three. Daily windows only (an hour is noise).
 * `heldFrom`: the findings the store holds start here (a capped feed); the window is read from there on.
 */
export function finderShifts(signals: ReadonlyArray<{ source: string; judge?: string | null; created_at: number; observed_at?: number | null; task_id?: string | null }>, win: OverviewWindow, heldFrom: number | null = null): FinderShift[] {
  if (win.step < DAY) return [];
  const start = Math.max(win.d0, heldFrom ?? win.d0);
  const first = Math.ceil((start - win.d0) / win.step);
  const by = new Map<string, { source: string; judge: string | null; c: number[] }>();
  let total = 0;
  for (const s of signals) {
    const at = atOf(s);
    if (!s.task_id || at < start || at >= win.d1) continue;
    const i = Math.floor((at - win.d0) / win.step);
    const judge = s.source.startsWith("judge:") ? null : s.judge || null;
    const key = judge ? `${s.source}/${judge}` : s.source;
    const e = by.get(key) ?? by.set(key, { source: s.source, judge, c: Array(win.n).fill(0) }).get(key)!;
    e.c[i]++;
    total++;
  }
  const days = win.n - first;
  if (days < 4 || !total) return [];
  const floor = Math.max(10, (total / days) * 0.1);
  const out: Array<FinderShift & { lost: number }> = [];
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  for (const [key, { source, judge, c }] of by) {
    const seen = c.slice(first);
    let last = -1;
    seen.forEach((v, i) => { if (v > 0) last = i; });
    if (last < 0) continue;
    const head = seen.slice(0, last + 1);
    // Stopped: nothing on the last two days or more. Far less: the split that loses the most, the days after averaging
    // at most a fifth of the days before. Whichever explains more of the missing findings is the one said.
    let best: (FinderShift & { lost: number }) | null = null;
    if (seen.length - 1 - last >= 2 && mean(head) >= floor / 2 && head.reduce((x, y) => x + y, 0) >= floor) {
      best = { key, source, judge, kind: "stopped", from: first + last + 1, before: head.reduce((x, y) => x + y, 0), after: 0, beforeDays: head.length, lastAt: win.d0 + (first + last) * win.step, lost: mean(head) * (seen.length - 1 - last) };
    }
    for (let k = 2; k <= seen.length - 2; k++) {
      const b = mean(seen.slice(0, k)), a = mean(seen.slice(k));
      if (b < floor || a > b * 0.2) continue;
      const lost = (b - a) * (seen.length - k);
      if (!best || lost > best.lost) best = { key, source, judge, kind: "less", from: first + k, before: seen.slice(0, k).reduce((x, y) => x + y, 0), after: seen.slice(k).reduce((x, y) => x + y, 0), beforeDays: k, lastAt: null, lost };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => y.lost - x.lost).slice(0, 3).map(({ lost: _, ...f }) => f);
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

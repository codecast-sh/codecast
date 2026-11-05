// What a metric chart draws, worked out from its props with no drawing in
// it: the runs of the line (broken at holes, cut at the window's edges),
// values standing alone, the previous period and a query's preview by the
// same rule, the alerting bands (agreeing with the listed transitions when
// the page has them), the strip of time past the line, the stretches with
// no values, and the y range everything must fit in. MetricPlot paints it.
import {
  COARSE_STEP, alertBands, clipRunToWindow, crosses, cutHoles, dataHoles, inWindow, lineRuns, splitAtHoles, ticksOf, valueNear, yDomain,
  type DataHole, type Direction, type Pt, type Win,
} from "../metricModel";
import type { SeriesPt } from "../metricSeries";
import { bandsFromTransitions } from "../metricEvents";
import { bandAt } from "../metricEditing";

export type Seg = Pt[];

/** Each run split where it crosses the line: the stretches on the safe side and the stretches past it, joined at the exact crossing. */
export function splitAtLine(segs: Seg[], line: number | undefined, direction: Direction): { safe: Seg[]; past: Seg[] } {
  if (line === undefined) return { safe: segs, past: [] };
  const safe: Seg[] = [], past: Seg[] = [];
  for (const s of segs) {
    let cur: Seg = [];
    let curPast = s.length ? crosses(s[0].value, line, direction) : false;
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      const isPast = crosses(p.value, line, direction);
      if (i > 0 && isPast !== curPast) {
        const a = s[i - 1];
        const f = (line - a.value) / (p.value - a.value || 1);
        const x = { at: a.at + (p.at - a.at) * f, value: line };
        cur.push(x);
        (curPast ? past : safe).push(cur);
        cur = [x];
        curPast = isPast;
      }
      cur.push(p);
    }
    if (cur.length) (curPast ? past : safe).push(cur);
  }
  return { safe, past };
}

export type PlotInput = {
  points: SeriesPt[];
  win: Win;
  interval_ms: number;
  threshold?: number;
  warn?: number;
  direction: Direction;
  compare?: Pt[];
  full: boolean;
  loading: boolean;
  preview?: Pt[];
  ghostLine?: number;
  gap?: Win | null;
  episodes?: Win[];
  transitions?: readonly { at: number; kind: "crossed" | "recovered"; value: number | null; inferred?: boolean }[];
  poll_ms?: number;
  live?: Pt | null;
  unit?: string;
};

export type Tick = { pt: Pt; from: number; to: number };

export type PlotModel = {
  visible: SeriesPt[];
  /** Joined stretches of the line, each cut at the window's edges. */
  segs: Pt[][];
  /** Values read alone, drawn as a short dash (full) or a dot (card). */
  ticks: Tick[];
  /** Values on a run read far apart on screen, each marked with a dot. */
  marked: Pt[];
  /** Folded buckets' min to max, behind the line. */
  ranges: SeriesPt[][];
  prevSegs: Pt[][];
  prevTicks: Tick[];
  previewSegs: Pt[][];
  previewTicks: Tick[];
  holes: DataHole[];
  /** Where the chart shades the time past the line. */
  bands: Win[];
  /** The strip under the plot: time past the line, cut at holes. */
  strip: Win[];
  turns: { at: number; kind: "crossed" | "recovered"; value: number; inferred?: boolean }[];
  /** The newest value inside the window. */
  last: Pt | null;
  /** A value read just now past the series' newest point. */
  live: Pt | null;
  y: [number, number];
  alerting: boolean;
};

/** How far past the spacing around it a gap must run before a card's line breaks there (the full chart breaks at 2.2). */
const CARD_JOIN = 6;

export function plotModel(p: PlotInput): PlotModel {
  const { win, interval_ms, threshold, direction, full, loading } = p;
  const visible = loading ? [] : inWindow(p.points, win);
  const shownPreview = p.preview ? inWindow(p.preview, win) : [];
  const prev = p.compare ? p.compare.filter(x => x.at >= win.from && x.at <= win.to) : [];
  const turns = full && !loading && p.transitions
    ? p.transitions.filter((t): t is typeof t & { value: number } => t.value !== null && t.at >= win.from && t.at <= win.to)
    : [];
  const live = p.live && !loading && p.live.at >= win.from && p.live.at <= win.to ? p.live : null;
  const span = win.to - win.from || 1;
  const runs = lineRuns(visible, interval_ms, full ? undefined : CARD_JOIN);
  const holes = full && !loading ? dataHoles(p.points, interval_ms, p.poll_ms ?? interval_ms).filter(h => h.to > win.from && h.from < win.to) : [];
  const within = (x: Pt) => x.at >= win.from && x.at <= win.to;
  const joined = runs.filter(r => !r.sparse).flatMap(r => splitAtHoles(r.points, holes));
  const segs = joined.map(pts => clipRunToWindow(pts, win)).filter(s => s.length > 0);
  // The y axis fits what the window draws: values inside it, the line as cut at its edges, and folded buckets' extremes
  // inside it. Neighbours kept just outside it (a lone value weeks before the rest) never stretch it.
  const extremes = visible.flatMap(x => (within(x) && x.min !== undefined && x.max !== undefined ? [{ at: x.at, value: x.min }, { at: x.at, value: x.max }] : []));
  const y = yDomain([
    [...visible.filter(within), ...segs.flat()], prev, extremes, shownPreview, turns, live ? [live] : [],
    p.warn === undefined ? [] : [{ at: win.to, value: p.warn }],
    p.ghostLine === undefined ? [] : [{ at: win.to, value: p.ghostLine }],
  ], threshold, p.unit);
  const ranges = full ? joined.map(pts => pts.filter(x => x.min !== undefined && x.max !== undefined && x.max > x.min)).filter(r => r.length > 1) : [];
  const sparse = runs.filter(r => r.sparse);
  // At a few hundred pixels wide, a run whose values sit 1% of the width apart reads as dots on a line.
  const marked = runs.filter(r => !r.sparse && r.step / span >= 0.009).flatMap(r => r.points).filter(within);
  const minHalf = span * 0.004;
  const ticks = ticksOf(sparse.flatMap(r => r.points).filter(within), minHalf, visible).map(t => ({
    ...t,
    from: holes.some(h => h.to === t.pt.at) ? Math.max(t.from, t.pt.at - minHalf) : t.from,
    to: holes.some(h => h.from === t.pt.at) ? Math.min(t.to, t.pt.at + minHalf) : t.to,
  }));
  const prevRuns = lineRuns(prev, interval_ms);
  const prevSegs = prevRuns.filter(r => !r.sparse).map(r => r.points);
  const prevTicks = ticksOf(prevRuns.filter(r => r.sparse).flatMap(r => r.points), minHalf, prev);
  const previewRuns = lineRuns(shownPreview, interval_ms);
  const previewSegs = previewRuns.filter(r => !r.sparse).map(r => clipRunToWindow(r.points, win)).filter(s => s.length > 0);
  const previewTicks = ticksOf(previewRuns.filter(r => r.sparse).flatMap(r => r.points).filter(within), minHalf, shownPreview);

  // With the page's transitions, the bands run from a crossing to the recovery the list names, so the shading and
  // the list agree on when an episode ended; a window that opens past the line with nothing listed before it still
  // shades that stretch. A value read just now past the line is banded like any other.
  const banded = live && (!visible.length || live.at > visible[visible.length - 1].at) ? [...visible, live] : visible;
  const own = alertBands(banded, threshold, direction, win.to);
  let valueBands: Win[];
  if (!p.transitions) valueBands = cutHoles(own, holes);
  else {
    const listed = bandsFromTransitions(p.transitions, win.to).filter(b => b.to >= win.from && b.from <= win.to);
    const head = own[0] && banded[0] && own[0].from === banded[0].at && !listed.some(b => b.from <= own[0].from && b.to >= own[0].from) ? [own[0]] : [];
    valueBands = cutHoles([...head, ...listed], holes);
  }
  // Where no values are held, the announced episodes stand in for the values' own bands.
  const gapBands = p.gap && p.episodes ? p.episodes.filter(e => e.from < p.gap!.to).map(e => ({ from: e.from, to: Math.min(e.to, p.gap!.to) })) : [];
  const bands = [...gapBands, ...valueBands];
  const strip = p.episodes ? cutHoles(p.episodes, holes) : valueBands;
  const last = [...visible].reverse().find(within) ?? null;
  return {
    visible, segs, ticks, marked, ranges, prevSegs, prevTicks, previewSegs, previewTicks, holes, bands, strip, turns, last, live, y,
    alerting: !!last && threshold !== undefined && crosses(last.value, threshold, direction),
  };
}

export type PlotHover = {
  at: number;
  pt: Pt | null;
  prev: Pt | null;
  /** The spacing the value was read at, when coarser than the polls. */
  apart: number | null;
  band: (Win & { open: boolean }) | null;
  hole: DataHole | null;
};

/** What the tip names at a moment: the value read there, the prior period's, a band or hole it falls in. */
export function hoverAt(m: PlotModel, p: PlotInput, at: number): PlotHover {
  const { win, interval_ms } = p;
  const span = win.to - win.from || 1;
  const tol = Math.max(interval_ms * 1.5, span / 40);
  const sparsePts = m.ticks.map(t => t.pt);
  const pt = valueNear(m.visible, at, tol) ?? (sparsePts.length ? valueNear(sparsePts, at, span / 12) : null);
  const runs = lineRuns(m.visible, interval_ms);
  const run = pt ? runs.find(r => r.points.some(x => x.at === pt.at)) : undefined;
  const apart = run && !run.sparse && run.step >= Math.max(2 * interval_ms, COARSE_STEP) ? run.step : null;
  const band = bandAt(m.strip, at);
  const hole = m.holes.find(h => at > h.from && at < h.to) ?? null;
  const shownPt = hole && pt && Math.abs(pt.at - at) > interval_ms * 1.5 ? null : pt;
  const prev = p.compare ? valueNear(p.compare.filter(x => x.at >= win.from && x.at <= win.to), at, tol) : null;
  return { at, pt: shownPt, prev, apart: shownPt ? apart : null, band: band ? { ...band, open: band.to >= win.to - 60_000 } : null, hole: shownPt ? null : hole };
}

// The arithmetic every Evals chart shares: scales, the median step line, the
// rep jitter inside a batch column and the nearest point under a cursor. Pure,
// so the strip, the seismograph, the ledger and the lanes agree on geometry.

/** The pass mark every score is held to unless a score says otherwise. */
export const PASS_MARK = 0.7;
export const DAY_MS = 86_400_000;

export interface Scale {
  (v: number): number;
  invert: (px: number) => number;
  domain: readonly [number, number];
  range: readonly [number, number];
}

/** A linear map from [d0, d1] to [r0, r1]; a zero-width domain maps to the middle of the range. */
export function linear(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0;
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as Scale;
  f.invert = (px: number) => (r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

/** Score 0 at the bottom, 1 at the top. */
export const scoreScale = (top: number, bottom: number) => linear(0, 1, bottom, top);

/** A step-after line through points sorted by x: each value holds until the next. */
export function stepPath(points: ReadonlyArray<{ x: number; y: number }>, endX?: number): string {
  if (!points.length) return "";
  let d = `M${r(points[0].x)},${r(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `H${r(points[i].x)}V${r(points[i].y)}`;
  if (endX !== undefined && endX > points[points.length - 1].x) d += `H${r(endX)}`;
  return d;
}

const r = (v: number) => Math.round(v * 10) / 10;

/** A stable offset in [-spread, spread] for a key, so a rep keeps its place in its column across renders. */
export function jitter(key: string, spread: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return ((h % 10_000) / 10_000) * 2 * spread - spread;
}

/** The index of the value nearest x in an ascending list, or -1 for an empty one. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** Local `YYYY-MM-DD` for every day from `from` to `to`, the shape ActivityCharts' timeAxisLabels reads. */
export function dayList(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

/** Midnight of a `YYYY-MM-DD` local day, the inverse of dayList. */
export const dayStart = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

// "Better" needs evidence: an exact one-sided Mann-Whitney U on per-rep
// scores. Exact because the samples are small (5 to 8 reps a side), where
// the normal approximation is wrong; ties take midranks, and the null
// distribution of the rank sum is counted over every way to pick the first
// sample from the pooled ranks, so ties are exact too.

export interface MannWhitney {
  /** U for the first sample: pairs where it is greater, ties counting a half. */
  u: number;
  /** P(first sample ranks at least this high) under the null: small means the first is greater. */
  pGreater: number;
  /** P(first sample ranks at most this high): small means the first is less. */
  pLess: number;
}

export function mannWhitney(a: number[], b: number[]): MannWhitney {
  const n1 = a.length;
  const pooled = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))].sort((x, y) => x.v - y.v);
  const n = pooled.length;
  // Doubled midranks keep every rank an integer.
  const rank2 = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && pooled[j + 1]!.v === pooled[i]!.v) j++;
    for (let k = i; k <= j; k++) rank2[k] = i + j + 2;
    i = j + 1;
  }
  const observed = pooled.reduce((sum, p, i) => sum + (p.first ? rank2[i]! : 0), 0);
  // ways[k][s]: subsets of k ranks whose doubled sum is s.
  const maxSum = rank2.reduce((s, r) => s + r, 0);
  let ways: number[][] = Array.from({ length: n1 + 1 }, () => new Array<number>(maxSum + 1).fill(0));
  ways[0]![0] = 1;
  for (const r of rank2) {
    const next = ways.map((row) => row.slice());
    for (let k = 1; k <= n1; k++) for (let s = r; s <= maxSum; s++) next[k]![s]! += ways[k - 1]![s - r]!;
    ways = next;
  }
  const dist = ways[n1]!;
  const total = dist.reduce((s, c) => s + c, 0);
  let ge = 0;
  let le = 0;
  dist.forEach((c, s) => {
    if (s >= observed) ge += c;
    if (s <= observed) le += c;
  });
  return { u: observed / 2 - (n1 * (n1 + 1)) / 2, pGreater: ge / total, pLess: le / total };
}

export const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export type Separation =
  | { kind: 'better' | 'worse'; p: number }
  | { kind: 'not-separated'; p: number }
  | { kind: 'too-few' };

export const MIN_SAMPLES = 5;
export const ALPHA = 0.05;

/** The separation rule: `current` against `previous`, one-sided each way at p <= 0.05, 5+ reps a side. */
export function separate(current: number[], previous: number[]): Separation {
  if (current.length < MIN_SAMPLES || previous.length < MIN_SAMPLES) return { kind: 'too-few' };
  const mw = mannWhitney(current, previous);
  if (mw.pGreater <= ALPHA) return { kind: 'better', p: mw.pGreater };
  if (mw.pLess <= ALPHA) return { kind: 'worse', p: mw.pLess };
  return { kind: 'not-separated', p: Math.min(mw.pGreater, mw.pLess) };
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const range = (xs: number[]) => (xs.length ? `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}` : '-');

/** The line `check` prints under a surface's verdict. */
export function separationLine(current: number[], previous: number[]): string {
  const s = separate(current, previous);
  if (s.kind === 'too-few') return `too few samples to separate (need ${MIN_SAMPLES}+ per side)`;
  if (s.kind === 'not-separated') return `not separated: medians ${fmt(median(current))} vs ${fmt(median(previous))}, ranges ${range(current)} vs ${range(previous)}`;
  return `separated: ${s.kind} (p=${s.p.toFixed(4)})`;
}

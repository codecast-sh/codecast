// "Better" needs evidence: a one-sided Mann-Whitney U on per-rep scores.
// Exact while the samples are small (5 to 8 reps a side on one freeze, a
// surface's few dozen), where the normal approximation is wrong; ties take
// midranks, and the null distribution of the rank sum is counted over every
// way to pick the smaller sample from the pooled ranks, so ties are exact too.
// Past EXACT_MAX_STEPS of that count (hundreds of reps a side, minutes of
// counting) the same null is sampled instead: PERMUTATIONS seeded draws from
// the same pooled ranks. The normal approximation is no substitute there,
// because eval scores tie heavily (one failed rep among two hundred passes
// would read as a fall). A cadence batch is weighed night by night per freeze
// instead (separateNights), and a check's regressions across surfaces under
// Holm (holdsAcross).

import { makeRng } from '@codecast/shared/random';

export interface MannWhitney {
  /** U for the first sample: pairs where it is greater, ties counting a half. */
  u: number;
  /** P(first sample ranks at least this high) under the null: small means the first is greater. */
  pGreater: number;
  /** P(first sample ranks at most this high): small means the first is less. */
  pLess: number;
}

/** The exact count's cost, in table updates, beyond which mannWhitney approximates (about a second on a loaded machine). */
export const EXACT_MAX_STEPS = 5e7;

/** Doubled midranks of the pooled samples (every rank an integer), with which sample each belongs to. */
function pooledRanks(a: number[], b: number[]): { rank2: number[]; first: boolean[] } {
  const pooled = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))].sort((x, y) => x.v - y.v);
  const n = pooled.length;
  const rank2 = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && pooled[j + 1]!.v === pooled[i]!.v) j++;
    for (let k = i; k <= j; k++) rank2[k] = i + j + 2;
    i = j + 1;
  }
  return { rank2, first: pooled.map((p) => p.first) };
}

export function mannWhitney(a: number[], b: number[]): MannWhitney {
  const n1 = a.length;
  const { rank2, first } = pooledRanks(a, b);
  const n = rank2.length;
  const observed = rank2.reduce((sum, r, i) => sum + (first[i] ? r : 0), 0);
  const u = observed / 2 - (n1 * (n1 + 1)) / 2;
  const maxSum = rank2.reduce((s, r) => s + r, 0);
  // The null is counted over the smaller sample's rank sum, whichever side it is: the larger side's sum is the rest, so its tails mirror.
  const m = Math.min(n1, n - n1);
  const mirrored = m !== n1;
  const own = mirrored ? maxSum - observed : observed;
  const tails = n * m * maxSum > EXACT_MAX_STEPS ? sampledTails(rank2, m, own) : exactTails(rank2, m, own);
  return mirrored ? { u, pGreater: tails.pLess, pLess: tails.pGreater } : { u, ...tails };
}

/** Both tails of the rank sum of `m` members drawn from the pooled ranks, counted exactly: about n * m * sum(rank2) table updates. */
function exactTails(rank2: number[], m: number, observed: number): Pick<MannWhitney, 'pGreater' | 'pLess'> {
  const maxSum = rank2.reduce((s, r) => s + r, 0);
  // ways[k * (maxSum + 1) + s]: subsets of k ranks whose doubled sum is s, filled in place from the top so each rank is used once.
  const width = maxSum + 1;
  const ways = new Float64Array((m + 1) * width);
  ways[0] = 1;
  let reach = 0;
  rank2.forEach((r, i) => {
    reach += r;
    for (let k = Math.min(m, i + 1); k >= 1; k--) {
      const row = k * width;
      const prev = row - width;
      for (let s = reach; s >= r; s--) ways[row + s]! += ways[prev + s - r]!;
    }
  });
  let total = 0;
  let ge = 0;
  let le = 0;
  for (let s = 0; s <= maxSum; s++) {
    const c = ways[m * width + s]!;
    total += c;
    if (s >= observed) ge += c;
    if (s <= observed) le += c;
  }
  return { pGreater: ge / total, pLess: le / total };
}

/** Draws a sampled tail takes past the exact count: its p is within about 0.005 of the exact one near 0.05. */
export const PERMUTATIONS = 20_000;

/**
 * Both tails of the rank sum of `m` members drawn from the pooled ranks, over
 * PERMUTATIONS uniform draws (a partial shuffle). Seeded by the sizes, so a
 * verdict reads the same every time it is printed.
 */
function sampledTails(rank2: number[], m: number, observed: number): Pick<MannWhitney, 'pGreater' | 'pLess'> {
  const n = rank2.length;
  const pool = Float64Array.from(rank2);
  const next = makeRng(n * 2654435761 + m);
  let ge = 0;
  let le = 0;
  for (let it = 0; it < PERMUTATIONS; it++) {
    let sum = 0;
    for (let i = 0; i < m; i++) {
      const j = i + Math.floor(next() * (n - i));
      const v = pool[j]!;
      pool[j] = pool[i]!;
      pool[i] = v;
      sum += v;
    }
    if (sum >= observed) ge++;
    if (sum <= observed) le++;
  }
  return { pGreater: (ge + 1) / (PERMUTATIONS + 1), pLess: (le + 1) / (PERMUTATIONS + 1) };
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

/** One freeze of a night-by-night comparison: tonight's mean score on it, and each earlier night's. */
export interface Stratum {
  current: number;
  previous: number[];
}

/**
 * A night against the nights before it, freeze by freeze (a stratified rank
 * test with the night as its unit). Reps of one night share that night's
 * provider and model state, so they are not independent draws; and pooling
 * every rep would weigh each freeze by how many reps and nights it happens to
 * have, reading a change in which freezes ran as a change in score. So each
 * freeze is one stratum holding one mean per night, and under the null every
 * night of a freeze is exchangeable: tonight's midrank among them is uniform
 * over the stratum's positions, independently per freeze. The statistic is
 * the sum of tonight's midranks, its null counted exactly by convolution.
 * One freeze among n nights cannot reach p <= ALPHA below n = 19, so a fall on
 * one freeze alone shows as that freeze failing, not as drift: too-few when
 * the design cannot separate whatever the scores.
 */
export function separateNights(strata: Stratum[]): Separation {
  const used = strata.filter((x) => x.previous.length > 0);
  if (!used.length || used.reduce((p, x) => p / (x.previous.length + 1), 1) > ALPHA) return { kind: 'too-few' };
  let dist = new Float64Array([1]);
  let observed = 0;
  for (const x of used) {
    const { rank2, first } = pooledRanks([x.current], x.previous);
    observed += rank2[first.indexOf(true)]!;
    const next = new Float64Array(dist.length + Math.max(...rank2));
    for (let s = 0; s < dist.length; s++) if (dist[s]) for (const r of rank2) next[s + r]! += dist[s]! / rank2.length;
    dist = next;
  }
  let pGreater = 0;
  let pLess = 0;
  dist.forEach((w, s) => {
    if (s >= observed) pGreater += w;
    if (s <= observed) pLess += w;
  });
  if (pGreater <= ALPHA) return { kind: 'better', p: pGreater };
  if (pLess <= ALPHA) return { kind: 'worse', p: pLess };
  return { kind: 'not-separated', p: Math.min(pGreater, pLess) };
}

/**
 * Holm's step-down over the separations one check weighs at once: which
 * `worse` separations still hold at ALPHA across all of them. Ten surfaces
 * each tested at 0.05 would raise a false regression on about two firings in
 * five; Holm keeps the chance of any false one at ALPHA. A too-few test is no
 * test and counts for nothing.
 */
export function holdsAcross(separations: Separation[]): boolean[] {
  const tested = separations.flatMap((s, i) => (s.kind === 'too-few' ? [] : [{ i, p: s.kind === 'worse' ? s.p : 1 }])).sort((a, b) => a.p - b.p);
  const out = separations.map(() => false);
  for (const [j, t] of tested.entries()) {
    if (t.p > ALPHA / (tested.length - j)) break;
    out[t.i] = true;
  }
  return out;
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const range = (xs: number[]) => (xs.length ? `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}` : '-');

/** The line `check` prints under a surface's verdict: `s`, the separation of `current` against `previous` unless the caller weighed them another way. */
export function separationLine(current: number[], previous: number[], s: Separation = separate(current, previous)): string {
  if (s.kind === 'too-few') return `too few samples to separate (need ${MIN_SAMPLES}+ per side)`;
  if (s.kind === 'not-separated') return `not separated: medians ${fmt(median(current))} vs ${fmt(median(previous))}, ranges ${range(current)} vs ${range(previous)}`;
  return `separated: ${s.kind} (p=${s.p.toFixed(4)})`;
}

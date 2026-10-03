// "Better" needs evidence: a one-sided Mann-Whitney U on per-rep scores.
// Exact while the samples are small (5 to 8 reps a side on one freeze, a
// surface's few dozen), where the normal approximation is wrong; ties take
// midranks, and the null distribution of the rank sum is counted over every
// way to pick the first sample from the pooled ranks, so ties are exact too.
// Past EXACT_MAX_STEPS of that count (a cadence batch against a pool of
// nights: hundreds of reps a side, minutes of counting) the same null is
// sampled instead: PERMUTATIONS seeded draws of the first sample from the same
// pooled ranks. The normal approximation is no substitute there, because eval
// scores tie heavily (one failed rep among two hundred passes would read as a
// fall).

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
  if (n * Math.min(n1, n - n1) * maxSum > EXACT_MAX_STEPS) return { u, ...sampledTails(rank2, n1, observed) };
  // ways[k * (maxSum + 1) + s]: subsets of k ranks whose doubled sum is s, filled in place from the top so each rank is used once.
  const width = maxSum + 1;
  const ways = new Float64Array((n1 + 1) * width);
  ways[0] = 1;
  let reach = 0;
  rank2.forEach((r, i) => {
    reach += r;
    for (let k = Math.min(n1, i + 1); k >= 1; k--) {
      const row = k * width;
      const prev = row - width;
      for (let s = reach; s >= r; s--) ways[row + s]! += ways[prev + s - r]!;
    }
  });
  let total = 0;
  let ge = 0;
  let le = 0;
  for (let s = 0; s <= maxSum; s++) {
    const c = ways[n1 * width + s]!;
    total += c;
    if (s >= observed) ge += c;
    if (s <= observed) le += c;
  }
  return { u, pGreater: ge / total, pLess: le / total };
}

/** Draws a sampled tail takes past the exact count: its p is within about 0.005 of the exact one near 0.05. */
export const PERMUTATIONS = 20_000;

/**
 * Both tails of the first sample's rank sum over PERMUTATIONS uniform draws
 * of its members from the pooled ranks (a partial shuffle of the smaller
 * side; the larger side's sum is the rest). Seeded by the samples' sizes, so a
 * verdict reads the same every time it is printed.
 */
function sampledTails(rank2: number[], n1: number, observed: number): Pick<MannWhitney, 'pGreater' | 'pLess'> {
  const n = rank2.length;
  const drawn = Math.min(n1, n - n1);
  const total = rank2.reduce((s, r) => s + r, 0);
  const pool = Float64Array.from(rank2);
  let state = (n * 2654435761 + n1) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let ge = 0;
  let le = 0;
  for (let it = 0; it < PERMUTATIONS; it++) {
    let sum = 0;
    for (let i = 0; i < drawn; i++) {
      const j = i + Math.floor(next() * (n - i));
      const v = pool[j]!;
      pool[j] = pool[i]!;
      pool[i] = v;
      sum += v;
    }
    const first = drawn === n1 ? sum : total - sum;
    if (first >= observed) ge++;
    if (first <= observed) le++;
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

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const range = (xs: number[]) => (xs.length ? `${fmt(Math.min(...xs))}-${fmt(Math.max(...xs))}` : '-');

/** The line `check` prints under a surface's verdict. */
export function separationLine(current: number[], previous: number[]): string {
  const s = separate(current, previous);
  if (s.kind === 'too-few') return `too few samples to separate (need ${MIN_SAMPLES}+ per side)`;
  if (s.kind === 'not-separated') return `not separated: medians ${fmt(median(current))} vs ${fmt(median(previous))}, ranges ${range(current)} vs ${range(previous)}`;
  return `separated: ${s.kind} (p=${s.p.toFixed(4)})`;
}

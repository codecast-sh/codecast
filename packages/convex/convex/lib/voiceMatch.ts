// Naming a voice note's speakers by voice (engine C, docs/architecture/
// speaker-attribution.md): pick each voice's clean stretches, embed them
// (infra/speech-worker, CAM++), and pair voices with people one to one.
// Pure functions, ports of the speech lab's identify.py (clean_windows,
// _budget, similarity "centroid", match) and kept identical to it by the
// parity fixtures in __fixtures__/voiceMatch.
import type { SpeakerTurn } from "@codecast/shared/contracts";

export type Window = [number, number];

/** The lab's accepted operating point: a pair stands at cosine >= 0.40 and
 *  at least 0.05 clear of that voice's next-best person. */
export const MATCH_THRESHOLD = 0.4;
export const MATCH_MARGIN = 0.05;
/** Seconds of clean speech embedded per voice in a recording, and per
 *  person when enrolling from one. */
export const CLUSTER_SECONDS = 90;
export const ENROLL_SECONDS = 60;
/** The embedding model the worker runs, and the voiceprints `engine` value. */
export const VOICE_ENGINE = "campplus-v1";

/**
 * Each voice's stretches that overlap nobody else: every turn, trimmed by
 * `pad` at both ends, minus every other voice's overlapping turn, cut into
 * windows of at most `maxLen` s (a remainder under `minLen` joins the
 * window before it) and dropped under `minLen`.
 */
export function cleanWindows(
  turns: ReadonlyArray<SpeakerTurn>,
  opts: { minLen?: number; maxLen?: number; pad?: number } = {},
): Map<string, Window[]> {
  const minLen = opts.minLen ?? 1.0;
  const maxLen = opts.maxLen ?? 8.0;
  const pad = opts.pad ?? 0.1;
  const out = new Map<string, Window[]>();
  for (const t of turns) {
    const s = t.start + pad;
    const e = t.end - pad;
    let pieces: Window[] = [[s, e]];
    for (const u of turns) {
      if (u.key === t.key || !(u.end > s && u.start < e)) continue;
      const [a, b] = [u.start, u.end];
      const next: Window[] = [];
      for (const [x, y] of pieces) {
        if (b <= x || a >= y) next.push([x, y]);
        else {
          if (a > x) next.push([x, a]);
          if (b < y) next.push([b, y]);
        }
      }
      pieces = next;
    }
    for (let [x, y] of pieces) {
      while (y - x >= minLen) {
        let z = Math.min(y, x + maxLen);
        if (y - z < minLen) z = y;
        if (!out.has(t.key)) out.set(t.key, []);
        out.get(t.key)!.push([x, z]);
        x = z;
      }
    }
  }
  return out;
}

/** The longest windows first, until `seconds` of speech is reached. */
export function budgetWindows(windows: ReadonlyArray<Window>, seconds: number): Window[] {
  const sorted = [...windows].sort((p, q) => p[0] - p[1] - (q[0] - q[1]));
  const out: Window[] = [];
  let total = 0;
  for (const w of sorted) {
    if (total >= seconds) break;
    out.push(w);
    total += w[1] - w[0];
  }
  return out;
}

/** The mean of a set of vectors. */
export function centroid(vectors: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const d = vectors[0]?.length ?? 0;
  const c = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) c[i] += v[i]!;
  for (let i = 0; i < d; i++) c[i] /= vectors.length;
  return c;
}

export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * A one-to-one assignment of rows to columns that maximizes the summed
 * score (the Hungarian method, O(n^2 m)); rows beyond the columns, or
 * columns beyond the rows, stay unpaired. Returns [row, col] pairs.
 */
export function maxAssignment(S: ReadonlyArray<ReadonlyArray<number>>): Array<[number, number]> {
  const rows = S.length;
  const cols = rows ? S[0]!.length : 0;
  if (!rows || !cols) return [];
  const flip = rows > cols;
  const n = flip ? cols : rows;
  const m = flip ? rows : cols;
  const cost = (i: number, j: number) => -(flip ? S[j]![i]! : S[i]![j]!);
  // e-maxx Hungarian, 1-indexed, n <= m.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const pairs: Array<[number, number]> = [];
  for (let j = 1; j <= m; j++) {
    if (!p[j]) continue;
    pairs.push(flip ? [j - 1, p[j]! - 1] : [p[j]! - 1, j - 1]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/**
 * Name voices by voice: each voice's centroid against each person's
 * centroid, paired one to one, and a pair stands only at or above
 * `threshold` and at least `margin` clear of that voice's next-best person.
 * Anyone left is unnamed (null): an honest unknown beats a confident wrong
 * name. Returns the names and every score.
 */
export function matchVoices<P extends string>(
  clusters: ReadonlyMap<string, ReadonlyArray<ReadonlyArray<number>>>,
  prints: ReadonlyMap<P, ReadonlyArray<ReadonlyArray<number>>>,
  opts: { threshold?: number; margin?: number } = {},
): { names: Map<string, P | null>; scores: Map<string, Map<P, number>> } {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const margin = opts.margin ?? MATCH_MARGIN;
  const cs = [...clusters.keys()].filter((c) => clusters.get(c)!.length);
  const ps = [...prints.keys()].filter((p) => prints.get(p)!.length);
  const names = new Map<string, P | null>([...clusters.keys()].map((c) => [c, null]));
  const scores = new Map<string, Map<P, number>>();
  if (!cs.length || !ps.length) return { names, scores };
  const pc = ps.map((p) => centroid(prints.get(p)!));
  const S = cs.map((c) => {
    const cc = centroid(clusters.get(c)!);
    return pc.map((q) => cosine(cc, q));
  });
  cs.forEach((c, r) => scores.set(c, new Map(ps.map((p, k) => [p, S[r]![k]!]))));
  for (const [r, k] of maxAssignment(S)) {
    const s = S[r]![k]!;
    const second = ps.length > 1 ? Math.max(...S[r]!.filter((_, j) => j !== k)) : -1;
    if (s >= threshold && s - second >= margin) names.set(cs[r]!, ps[k]!);
  }
  return { names, scores };
}

/** Speaker turns from words labeled with their voice: consecutive words of
 *  one voice less than 0.5 s apart are one turn (the lab's Scribe rule). */
export function turnsFromLabeledWords(words: ReadonlyArray<{ start: number; end: number; key?: string }>): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  let cur: SpeakerTurn | null = null;
  for (const w of words) {
    const key = w.key ?? "";
    if (cur && cur.key === key && w.start - cur.end < 0.5) cur.end = w.end;
    else {
      if (cur) turns.push(cur);
      cur = { key, start: w.start, end: w.end };
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// Problems that are the same problem under two ids (line-workspace.md LW1):
// near-identical titles mark a duplicate, filed against the oldest of them (a
// judge's "Not met: <expectation>" is one with the problem titled by it),
// so the line does not spend runs twice and a reviewer does not read the same
// fix twice. Problems whose findings mostly cite one expectation share a rule:
// a weaker tie, used to group asks that read alike. Pure.
import { drain, yieldEvery, type Sliced } from "../slicedWork";

export type OverlapItem = { id: string; ref: string | null; title: string; at: number; fingerprints?: ReadonlyArray<string> | null };

export type Overlap = {
  /** The oldest problem of its duplicate set (itself when it is that one). */
  primary: string;
  primaryRef: string | null;
  /** Every problem in its duplicate set, oldest first; one when it has no duplicate. */
  set: string[];
  /** The expectation most of its findings cite, when one does. */
  rule: string | null;
  /** Every problem that is the same defect: its duplicates, and the problems whose findings cite the same rule, oldest first. */
  defect: string[];
};

const STOP = new Set(["the", "and", "that", "this", "with", "from", "into", "when", "they", "their", "them", "what", "does", "not", "for", "who", "has", "had", "have", "its", "was", "were", "are", "but", "one", "met"]);

/** A title's content words: lowercase, three letters or more, the frame words (and any `extra`) left out. */
export function titleWords(title: string, extra?: ReadonlySet<string>): Set<string> {
  return new Set(title.toLowerCase().replace(/^not met:\s*/, "").split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !STOP.has(w) && !extra?.has(w)));
}

/** Shared members over all of them (Jaccard); 0 when either is empty. */
export function jaccard(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** How alike two titles read: their content words' Jaccard. */
export const titleSimilarity = (a: string, b: string, extra?: ReadonlySet<string>): number => jaccard(titleWords(a, extra), titleWords(b, extra));

/** Titles this alike name the same problem. */
export const SAME_TITLE = 0.6;

/** Under one rule, titles sharing this share of the shorter one's stems name the same defect. */
export const SAME_DEFECT = 0.3;

const stemmed = (w: ReadonlySet<string>) => new Set([...w].map((x) => x.replace(/'s$/, "").replace(/(?<=\w{3})(es|s)$/, "")));

/** Shared members over the smaller set's size: how much of the shorter title the longer one repeats. */
export function overlapShare(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

/** Words in so many of a process's titles that they say nothing about one of them (its product's own name, "contact"):
 *  more than a quarter of them, once there are enough titles to tell. Read off the titles, so no product's words live here. */
export function commonWords(titles: ReadonlyArray<string>, share = 0.25, min = 8): Set<string> {
  if (titles.length < min) return new Set();
  const df = new Map<string, number>();
  for (const t of titles) for (const w of titleWords(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n > titles.length * share).map(([w]) => w));
}

/** The expectation most of a problem's findings cite ("ex-agentwatch-trial-16"), when more than half do. */
export function ruleOf(fingerprints: ReadonlyArray<string> | null | undefined): string | null {
  const n = new Map<string, number>();
  for (const f of fingerprints ?? []) {
    const m = /\b(ex-[\w-]+)/.exec(f);
    if (m) n.set(m[1], (n.get(m[1]) ?? 0) + 1);
  }
  const top = [...n].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 > (fingerprints?.length ?? 0) ? top[0] : null;
}

/** Union-find over ids, the older root kept as the root, so a set is filed under its oldest member. */
function unionFind(sorted: ReadonlyArray<{ id: string }>) {
  const parent = new Map(sorted.map((i) => [i.id, i.id]));
  const rank = new Map(sorted.map((i, n) => [i.id, n]));
  const find = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) { const [old, young] = rank.get(ra)! < rank.get(rb)! ? [ra, rb] : [rb, ra]; parent.set(young, old); }
  };
  const sets = () => {
    const out = new Map<string, string[]>();
    for (const i of sorted) { const r = find(i.id); const set = out.get(r); if (set) set.push(i.id); else out.set(r, [i.id]); }
    return out;
  };
  return { find, join, sets };
}

/** A title as the expectation it quotes: lowercase, without a judge's "Not met:" frame, a trailing ellipsis or stop. */
const expectationText = (t: string) => t.toLowerCase().replace(/^not met:\s*/, "").replace(/(?:…|\.\.\.)\s*$/, "").replace(/\s+/g, " ").replace(/[\s.,;:]+$/, "").trim();

/** Whether two titles quote one expectation: a judge's "Not met: <expectation>" and a problem titled with that
 *  expectation (whole, or cut short), one the start of the other. Long enough that a stray short title never matches. */
export function sameExpectation(a: string, b: string): boolean {
  if (!/^not met:/i.test(a) && !/^not met:/i.test(b)) return false;
  return quotesSame(expectationText(a), expectationText(b));
}

/** The shortest expectation text that can match: two shorter never name one expectation. */
const EXPECTATION_MIN = 24;
const quotesSame = (a: string, b: string) => {
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  return x.length >= EXPECTATION_MIN && y.startsWith(x);
};

/** Whether two titles' sorted word ranks reach SAME_TITLE's Jaccard: the shared count they need, or a merge that
 *  stops once what is left of either cannot reach it. */
function sharesTitle(x: Int32Array, y: Int32Array): boolean {
  const need = Math.ceil((SAME_TITLE / (1 + SAME_TITLE)) * (x.length + y.length) - 1e-9);
  if (!x.length || !y.length || Math.min(x.length, y.length) < need) return false;
  let both = 0;
  for (let a = 0, b = 0; a < x.length && b < y.length;) {
    if (both + Math.min(x.length - a, y.length - b) < need) return false;
    if (x[a] === y[b]) { both++; a++; b++; } else if (x[a] < y[b]) a++; else b++;
  }
  return both / (x.length + y.length - both) >= SAME_TITLE;
}

/** The indexes holding each non-null key, in order: the groups a pairwise pass runs inside. */
function groupIndexes(keys: ReadonlyArray<string | null>): number[][] {
  const by = new Map<string, number[]>();
  keys.forEach((k, i) => { if (k === null) return; const at = by.get(k); if (at) at.push(i); else by.set(k, [i]); });
  return [...by.values()];
}

/** Every pair i < j of a group, in order. */
function eachPair(at: ReadonlyArray<number>, f: (i: number, j: number) => void) {
  for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) f(at[a], at[b]);
}

/** Each problem's duplicate set, its rule, and the wider set of problems that are the same defect. A problem joins a
 *  duplicate set when its title reads like any member's; it joins a defect when it is a duplicate or its findings
 *  cite the same rule. */
export function problemOverlaps(items: ReadonlyArray<OverlapItem>): Map<string, Overlap> {
  return drain(problemOverlapsSteps(items));
}

/** problemOverlaps, stopping every few hundred problems (lib/slicedWork). */
export function* problemOverlapsSteps(items: ReadonlyArray<OverlapItem>): Sliced<Map<string, Overlap>> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const common = commonWords(sorted.map((i) => i.title));
  yield;
  const tick = yieldEvery(400);
  const words: Array<Set<string>> = [];
  for (const i of sorted) { if (tick()) yield; words.push(titleWords(i.title, common)); }
  const dup = unionFind(sorted);
  const defect = unionFind(sorted);
  const same = (i: number, j: number) => { dup.join(sorted[i].id, sorted[j].id); defect.join(sorted[i].id, sorted[j].id); };
  // Only pairs that can match are compared, never every pair (seconds of main thread over thousands of problems).
  // Each title is its words' ranks, rarest first. Titles at SAME_TITLE share at least that share of each title's
  // words, so each shares one of the other's first |words| - ceil(SAME_TITLE * |words|) + 1: only those are indexed,
  // and each candidate is counted in full.
  const df = new Map<string, number>();
  for (const ws of words) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const rank = new Map([...df.keys()].sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : 1)).map((w, n) => [w, n]));
  const ranks = words.map((ws) => Int32Array.from(ws, (w) => rank.get(w)!).sort());
  const holders = new Map<number, number[]>();
  const seen = new Int32Array(sorted.length).fill(-1);
  for (let i = 0; i < ranks.length; i++) {
    if (tick()) yield;
    const x = ranks[i];
    for (let k = 0; k < x.length - Math.ceil(SAME_TITLE * x.length) + 1; k++) {
      const at = holders.get(x[k]);
      if (!at) { holders.set(x[k], [i]); continue; }
      for (const j of at) {
        if (seen[j] === i) continue;
        seen[j] = i;
        if (sharesTitle(x, ranks[j])) same(j, i);
      }
      at.push(i);
    }
  }
  yield;
  const quoted = sorted.map((i) => ({ notMet: /^not met:/i.test(i.title), text: expectationText(i.title) }));
  const byStart = groupIndexes(quoted.map((q) => (q.text.length >= EXPECTATION_MIN ? q.text.slice(0, EXPECTATION_MIN) : null)));
  for (const at of byStart) eachPair(at, (i, j) => { if ((quoted[i].notMet || quoted[j].notMet) && quotesSame(quoted[i].text, quoted[j].text)) same(i, j); });
  // One rule covers many defects: two problems under it are one defect only when their titles also name the same thing.
  yield;
  const rules = sorted.map((i) => ruleOf(i.fingerprints));
  const stems = words.map((w, n) => (rules[n] ? stemmed(w) : w));
  for (const at of groupIndexes(rules)) eachPair(at, (i, j) => { if (overlapShare(stems[i], stems[j]) >= SAME_DEFECT) defect.join(sorted[i].id, sorted[j].id); });
  yield;
  const sets = dup.sets();
  const defects = defect.sets();
  const byId = new Map(sorted.map((i) => [i.id, i]));
  const out = new Map<string, Overlap>();
  sorted.forEach((i, n) => {
    const set = sets.get(dup.find(i.id))!;
    out.set(i.id, { primary: set[0], primaryRef: byId.get(set[0])?.ref ?? null, set, rule: rules[n], defect: defects.get(defect.find(i.id))! });
  });
  return out;
}

/** Rows ordered with every problem of a defect right after the oldest of it that is listed. With `open`, the rest of a
 *  defect folds away under that row unless its id is in `open`; without it, every row shows. */
export function withDuplicatesUnderPrimary<T extends { id: string }>(rows: ReadonlyArray<T>, overlaps: ReadonlyMap<string, Overlap>, open?: ReadonlySet<string>): T[] {
  const listed = new Set(rows.map((r) => r.id));
  const headOf = (id: string) => overlaps.get(id)?.defect.find((x) => listed.has(x)) ?? id;
  const under = new Map<string, T[]>();
  const top: T[] = [];
  for (const r of rows) {
    const head = headOf(r.id);
    if (head !== r.id) under.set(head, [...(under.get(head) ?? []), r]);
    else top.push(r);
  }
  return top.flatMap((r) => [r, ...(!open || open.has(r.id) ? under.get(r.id) ?? [] : [])]);
}

/** The listed head of a row's defect and the other listed problems under it: what a folded row counts. */
export function defectHeads<T extends { id: string }>(rows: ReadonlyArray<T>, overlaps: ReadonlyMap<string, Overlap>): Map<string, T[]> {
  const listed = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const head = overlaps.get(r.id)?.defect.find((x) => listed.has(x)) ?? r.id;
    if (head !== r.id) out.set(head, [...(out.get(head) ?? []), r]);
  }
  return out;
}

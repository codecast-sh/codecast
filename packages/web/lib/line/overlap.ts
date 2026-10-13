// Problems that are the same problem under two ids (line-workspace.md LW1):
// near-identical titles mark a duplicate, filed against the oldest of them (a
// judge's "Not met: <expectation>" is one with the problem titled by it),
// so the line does not spend runs twice and a reviewer does not read the same
// fix twice. Problems whose findings mostly cite one expectation share a rule:
// a weaker tie, used to group asks that read alike. Pure.

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
    for (const i of sorted) { const r = find(i.id); out.set(r, [...(out.get(r) ?? []), i.id]); }
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
  const [x, y] = [expectationText(a), expectationText(b)].sort((p, q) => p.length - q.length);
  return x.length >= 24 && y.startsWith(x);
}

/** Each problem's duplicate set, its rule, and the wider set of problems that are the same defect. A problem joins a
 *  duplicate set when its title reads like any member's; it joins a defect when it is a duplicate or its findings
 *  cite the same rule. */
export function problemOverlaps(items: ReadonlyArray<OverlapItem>): Map<string, Overlap> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const common = commonWords(sorted.map((i) => i.title));
  const words = sorted.map((i) => titleWords(i.title, common));
  const dup = unionFind(sorted);
  const defect = unionFind(sorted);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (jaccard(words[i], words[j]) < SAME_TITLE && !sameExpectation(sorted[i].title, sorted[j].title)) continue;
      dup.join(sorted[i].id, sorted[j].id);
      defect.join(sorted[i].id, sorted[j].id);
    }
  }
  // One rule covers many defects: two problems under it are one defect only when their titles also name the same thing.
  const rules = sorted.map((i) => ruleOf(i.fingerprints));
  const stems = words.map(stemmed);
  for (let i = 0; i < sorted.length; i++) {
    if (!rules[i]) continue;
    for (let j = i + 1; j < sorted.length; j++) if (rules[j] === rules[i] && overlapShare(stems[i], stems[j]) >= SAME_DEFECT) defect.join(sorted[i].id, sorted[j].id);
  }
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

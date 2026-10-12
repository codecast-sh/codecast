// Problems that are the same problem under two ids (line-workspace.md LW1):
// near-identical titles mark a duplicate, filed against the oldest of them,
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
};

const STOP = new Set(["the", "and", "that", "this", "with", "from", "into", "when", "they", "their", "them", "what", "does", "not", "for", "who", "has", "had", "have", "its", "was", "were", "are", "but", "one", "met", "union", "contact", "contacts", "message"]);

/** A title's content words: lowercase, three letters or more, the frame words left out. */
export function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/^not met:\s*/, "").split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** How alike two titles read: shared content words over all of them (Jaccard). */
export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Titles this alike name the same problem. */
export const SAME_TITLE = 0.6;

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

/** Each problem's duplicate set and rule. A problem joins a set when its title reads like any member's. */
export function problemOverlaps(items: ReadonlyArray<OverlapItem>): Map<string, Overlap> {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const parent = new Map(sorted.map((i) => [i.id, i.id]));
  const rank = new Map(sorted.map((i, n) => [i.id, n]));
  const find = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  const words = sorted.map((i) => titleWords(i.title));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = words[i];
      const b = words[j];
      if (!a.size || !b.size) continue;
      let both = 0;
      for (const w of a) if (b.has(w)) both++;
      if (both / (a.size + b.size - both) < SAME_TITLE) continue;
      const ra = find(sorted[i].id);
      const rb = find(sorted[j].id);
      // The older root stays the root: sets are filed under their oldest problem.
      if (ra !== rb) { const [old, young] = rank.get(ra)! < rank.get(rb)! ? [ra, rb] : [rb, ra]; parent.set(young, old); }
    }
  }
  const sets = new Map<string, string[]>();
  for (const i of sorted) { const r = find(i.id); sets.set(r, [...(sets.get(r) ?? []), i.id]); }
  const byId = new Map(sorted.map((i) => [i.id, i]));
  const out = new Map<string, Overlap>();
  for (const i of sorted) {
    const set = sets.get(find(i.id))!;
    out.set(i.id, { primary: set[0], primaryRef: byId.get(set[0])?.ref ?? null, set, rule: ruleOf(i.fingerprints) });
  }
  return out;
}

/** Rows ordered with each duplicate right after the oldest of its set, when both are listed; the rest keep their order. */
export function withDuplicatesUnderPrimary<T extends { id: string }>(rows: ReadonlyArray<T>, overlaps: ReadonlyMap<string, Overlap>): T[] {
  const listed = new Set(rows.map((r) => r.id));
  const under = new Map<string, T[]>();
  const top: T[] = [];
  for (const r of rows) {
    const o = overlaps.get(r.id);
    if (o && o.primary !== r.id && listed.has(o.primary)) under.set(o.primary, [...(under.get(o.primary) ?? []), r]);
    else top.push(r);
  }
  return top.flatMap((r) => [r, ...(under.get(r.id) ?? [])]);
}

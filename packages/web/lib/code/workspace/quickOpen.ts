// Quick open's ranking: every file in the vault scan, fuzzy matched on its
// name and its path, recent files first. Pure and synchronous: the dialog
// calls `rankFiles` on each keystroke and must answer in well under a frame
// for 20k files (quickOpen.test.ts measures it).
//
// The index keeps fuzzysort's prepared targets, which is where the speed comes
// from, and lives as long as the set of paths does. The vault store copies its
// whole file table on every save and watcher event, so a new table object
// usually holds the same paths: the index then comes back as the same array,
// and a table that did gain or lose paths prepares only the new ones.

import fuzzysort from "fuzzysort";

export interface QuickOpenTarget {
  path: string;
  name: string;
  /** The folder, "" at the root. */
  dir: string;
  prepName: Fuzzysort.Prepared;
  prepPath: Fuzzysort.Prepared;
}

export interface QuickOpenResult {
  target: QuickOpenTarget;
  /** Matched character indexes in `name` / `path`, for highlighting. */
  nameIndexes: readonly number[] | null;
  pathIndexes: readonly number[] | null;
  score: number;
}

export interface ParsedQuery {
  text: string;
  /** 1-based, from `name:42` or `name:42:5`. */
  line?: number;
  column?: number;
}

/** `name:42:5` names a file and where to put the cursor. */
export function parseQuickOpenQuery(raw: string): ParsedQuery {
  const q = raw.trim();
  const m = /^(.*?)(?::(\d+))(?::(\d+))?:?$/.exec(q);
  if (!m) return { text: q };
  const line = parseInt(m[2], 10);
  return { text: m[1].trim(), line: line > 0 ? line : undefined, column: m[3] ? Math.max(1, parseInt(m[3], 10)) : undefined };
}

type FileTable = Record<string, { dir?: boolean }>;

/** The index for the last table seen, and its targets by path. */
let last: { files: FileTable; targets: QuickOpenTarget[]; byPath: Map<string, QuickOpenTarget> } | null = null;
const byPathOf = new WeakMap<QuickOpenTarget[], Map<string, QuickOpenTarget>>();

function prepare(path: string): QuickOpenTarget {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  return { path, name, dir: slash >= 0 ? path.slice(0, slash) : "", prepName: fuzzysort.prepare(name), prepPath: fuzzysort.prepare(path) };
}

const order = (a: QuickOpenTarget, b: QuickOpenTarget) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1);
const isFile = (files: FileTable, path: string) => {
  const row = files[path];
  return !!row && !row.dir;
};

/** Targets for every file (not folder) in a scan table, shortest path first.
 *  The same array while the table names the same files, whatever else about
 *  its rows changed. */
export function quickOpenIndex(files: FileTable): QuickOpenTarget[] {
  if (last?.files === files) return last.targets;
  if (!last) {
    const byPath = new Map<string, QuickOpenTarget>();
    for (const path in files) if (isFile(files, path)) byPath.set(path, prepare(path));
    const targets = [...byPath.values()].sort(order);
    byPathOf.set(targets, byPath);
    last = { files, targets, byPath };
    return targets;
  }
  const { byPath } = last;
  let count = 0;
  const added: QuickOpenTarget[] = [];
  for (const path in files) {
    if (!isFile(files, path)) continue;
    count++;
    if (!byPath.has(path)) added.push(prepare(path));
  }
  // Every known path still here, and nothing new: the same index.
  if (!added.length && count === byPath.size) {
    last = { ...last, files };
    return last.targets;
  }
  // Keep the sorted survivors and merge the few new targets in, rather than
  // sorting the whole vault again.
  added.sort(order);
  const targets: QuickOpenTarget[] = [];
  let i = 0;
  for (const t of last.targets) {
    if (!isFile(files, t.path)) {
      byPath.delete(t.path);
      continue;
    }
    while (i < added.length && order(added[i], t) < 0) targets.push(added[i++]);
    targets.push(t);
  }
  while (i < added.length) targets.push(added[i++]);
  for (const t of added) byPath.set(t.path, t);
  byPathOf.set(targets, byPath);
  last = { files, targets, byPath };
  return targets;
}

export const QUICK_OPEN_LIMIT = 60;

/**
 * Rank files for a query. Filename matches beat directory matches (a path
 * match counts for less unless the query itself names a folder), and a recent
 * file gets a lift that orders near ties without burying a much better match.
 * An empty query lists recent files, then the rest shortest path first.
 */
export function rankFiles(targets: QuickOpenTarget[], text: string, recent: readonly string[], limit = QUICK_OPEN_LIMIT): QuickOpenResult[] {
  const recency = new Map<string, number>();
  recent.forEach((p, i) => recency.has(p) || recency.set(p, i));
  if (!text) {
    let byPath = byPathOf.get(targets);
    if (!byPath) {
      byPath = new Map();
      for (const t of targets) byPath.set(t.path, t);
    }
    const out: QuickOpenResult[] = [];
    for (const p of recent) {
      const t = byPath.get(p);
      if (t && !out.some((r) => r.target === t)) out.push({ target: t, nameIndexes: null, pathIndexes: null, score: 1 });
      if (out.length >= limit) return out;
    }
    for (const t of targets) {
      if (out.length >= limit) break;
      if (!recency.has(t.path)) out.push({ target: t, nameIndexes: null, pathIndexes: null, score: 0 });
    }
    return out;
  }
  const namesFolder = text.includes("/");
  const pathWeight = namesFolder ? 1 : 0.8;
  const lift = (path: string) => {
    const r = recency.get(path);
    return r === undefined ? 0 : 0.12 * (1 - Math.min(r, 20) / 20);
  };
  const results = fuzzysort.go(text, targets, {
    keys: ["prepName", "prepPath"],
    limit,
    threshold: 0.2,
    scoreFn: (r) => {
      const name = namesFolder ? 0 : (r[0]?.score ?? 0);
      const path = (r[1]?.score ?? 0) * pathWeight;
      const base = Math.max(name, path);
      return base > 0 ? base + lift(r.obj.path) : 0;
    },
  });
  return results.map((r) => ({
    target: r.obj,
    nameIndexes: !namesFolder && r[0] && r[0].score > 0 ? r[0].indexes : null,
    pathIndexes: r[1] && r[1].score > 0 ? r[1].indexes : null,
    score: r.score,
  }));
}

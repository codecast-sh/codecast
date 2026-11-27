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
import { cursorParam } from "../../vault/vaultHref";

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
  /** 1-based, from `name:42`, `name:42:5`, `name:L42-50`, `name#L42`,
   *  `name(42,5)` or `name 42`. */
  line?: number;
  column?: number;
  /** The last line of a range (`:L42-50`): the editor flashes it. */
  endLine?: number;
  /** An absolute path outside the vault root: it opens through Files'
   *  local-path link, which finds the folder it belongs to. */
  outside?: boolean;
}

export interface ParseOptions {
  /** The vault's absolute root, stripped from a pasted absolute path. */
  root?: string | null;
  /** Whether a vault-relative path is a known file: decides a diff's
   *  `a/` / `b/` prefix. */
  isFile?: (path: string) => boolean;
}

// Where a pasted location says to go, at the end of the text: `:42`, `:42:5`,
// `:42:5:` (grep, tsc), `:L42`, `:L42-50` and `:42-50` (codecast quotes),
// `#L42` / `#L42-L50` (GitHub), `(42,5)` (tsc), ` 42`.
const AT = /^(.*?)(?:[:#]L?(\d+)(?:[:.,](\d+))?(?:-L?(\d+))?:?|\((\d+)(?:,\s*(\d+))?\):?|\s+(\d+))$/;

/** A query as someone types or pastes it: the file part and where to put the
 *  cursor. */
export function parseQuickOpenQuery(raw: string, opts: ParseOptions = {}): ParsedQuery {
  const q = raw.trim();
  const m = AT.exec(q);
  let text = (m ? m[1] : q).trim();
  const out: ParsedQuery = { text: "" };
  if (m) {
    const line = parseInt(m[2] ?? m[5] ?? m[7], 10);
    const column = m[3] ?? m[6];
    const end = m[4] ? parseInt(m[4], 10) : 0;
    if (line > 0) out.line = line;
    if (out.line && column) out.column = Math.max(1, parseInt(column, 10));
    if (out.line && end > out.line) out.endLine = end;
  }
  if (text.startsWith("file://")) text = decodeURIComponent(text.slice(7));
  const root = opts.root?.replace(/\/+$/, "");
  if (text.startsWith("/")) {
    if (root && text.startsWith(root + "/")) text = text.slice(root.length + 1);
    else out.outside = true;
  }
  if (!out.outside) {
    text = text.replace(/^(?:\.\/)+/, "");
    const unprefixed = /^[ab]\/(.+)$/.exec(text)?.[1];
    if (unprefixed && opts.isFile && !opts.isFile(text) && opts.isFile(unprefixed)) text = unprefixed;
  }
  out.text = text;
  return out;
}

/** The cursor spelling the workspace takes (`at` on a tab). */
export function queryAt(q: ParsedQuery): string | undefined {
  return cursorParam(q.line, q.column, q.endLine) || undefined;
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

/** The target for a path, from the index's own map. */
export function targetAt(targets: QuickOpenTarget[], path: string): QuickOpenTarget | undefined {
  return byPathOf.get(targets)?.get(path);
}

export const QUICK_OPEN_LIMIT = 60;

export interface RankOptions {
  limit?: number;
  /** The file being edited: among equal matches, files near it come first. */
  activePath?: string | null;
}

const RECENT_LIFT = 0.12;
const NEAR_LIFT = 0.06;
const SEGMENT_BONUS = { name: 0.08, exact: 0.05, prefix: 0.035, inside: 0.015 } as const;

/** How many leading folders a file shares with the active file's folder, as
 *  a lift: the same folder gets all of it, a cousin some. */
function nearness(activePath: string | null | undefined): (dir: string) => number {
  if (!activePath) return () => 0;
  const parts = activePath.split("/").slice(0, -1);
  if (!parts.length) return (dir) => (dir === "" ? NEAR_LIFT : 0);
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  return (dir) => {
    let shared = 0;
    for (const p of prefixes) {
      if (dir === p || dir.startsWith(p + "/")) shared++;
      else break;
    }
    if (!shared) return 0;
    // A file deeper than the active folder's own level shares no more than it.
    const exact = dir === prefixes[prefixes.length - 1];
    return NEAR_LIFT * (exact ? 1 : (shared / prefixes.length) * 0.8);
  };
}

/** Where a word other than the name's sits in a path, as a bonus and the
 *  indexes it covers: inside the file name itself (`code store` for
 *  codeStore.ts) beats a whole folder name beats the start of one beats the
 *  middle. Null when it is not in the path as written (letters scattered
 *  across folders never count: every monorepo path holds p, a, g and e). */
function wordIn(lowerPath: string, word: string, nameFrom: number): { bonus: number; indexes: number[] } | null {
  let at = -1;
  let best: { bonus: number; at: number } | null = null;
  while ((at = lowerPath.indexOf(word, at + 1)) >= 0) {
    const startsSegment = at === 0 || lowerPath[at - 1] === "/";
    const end = lowerPath[at + word.length];
    const bonus =
      at >= nameFrom
        ? SEGMENT_BONUS.name
        : startsSegment && end === "/"
          ? SEGMENT_BONUS.exact
          : startsSegment
            ? SEGMENT_BONUS.prefix
            : SEGMENT_BONUS.inside;
    if (!best || bonus > best.bonus) best = { bonus, at };
    if (bonus === SEGMENT_BONUS.name) break;
  }
  return best ? { bonus: best.bonus, indexes: Array.from(word, (_, i) => best!.at + i) } : null;
}

/**
 * Rank files for a query. Filename matches beat directory matches (a path
 * match counts for less unless the query itself names a folder), a recent
 * file gets a lift that orders near ties without burying a much better match,
 * and among equal matches a file near the active one comes first. Words
 * separated by spaces are a name and the folders it sits in (`cli index`,
 * `files page`): one word matches the file name, each other word must appear
 * in the path as written. An empty query lists recent files, then the rest
 * shortest path first.
 */
export function rankFiles(targets: QuickOpenTarget[], text: string, recent: readonly string[], opts: RankOptions = {}): QuickOpenResult[] {
  const limit = opts.limit ?? QUICK_OPEN_LIMIT;
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
  const near = nearness(opts.activePath);
  // Recency, then nearness, then a shorter path: a few hundredths at most.
  const lift = (t: QuickOpenTarget) => {
    const r = recency.get(t.path);
    return (r === undefined ? 0 : RECENT_LIFT * (1 - Math.min(r, 20) / 20)) + near(t.dir) - Math.min(t.path.length, 200) * 1e-5;
  };
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return rankWords(targets, words, lift, limit);
  const namesFolder = text.includes("/");
  const pathWeight = namesFolder ? 1 : 0.8;
  const results = fuzzysort.go(text, targets, {
    keys: ["prepName", "prepPath"],
    limit,
    threshold: 0.2,
    scoreFn: (r) => {
      const name = namesFolder ? 0 : (r[0]?.score ?? 0);
      const path = (r[1]?.score ?? 0) * pathWeight;
      const base = Math.max(name, path);
      return base > 0 ? base + lift(r.obj) : 0;
    },
  });
  return results.map((r) => {
    const name = namesFolder ? 0 : (r[0]?.score ?? 0);
    const byName = name > 0 && name >= (r[1]?.score ?? 0) * pathWeight;
    return {
      target: r.obj,
      nameIndexes: byName ? r[0].indexes : null,
      pathIndexes: !byName && r[1] && r[1].score > 0 ? r[1].indexes : null,
      score: r.score,
    };
  });
}

/** `dir … name` queries: each word in turn as the name (a word with a dot
 *  first), the others as words in the path. */
function rankWords(targets: QuickOpenTarget[], words: string[], lift: (t: QuickOpenTarget) => number, limit: number): QuickOpenResult[] {
  const lower = words.map((w) => w.toLowerCase());
  const dotted = lower.filter((w) => w.includes(".") && !w.includes("/"));
  const names = dotted.length ? dotted : lower.filter((w) => !w.includes("/"));
  const best = new Map<QuickOpenTarget, QuickOpenResult>();
  for (const nameWord of names) {
    const at = lower.indexOf(nameWord);
    const others = lower.filter((_, i) => i !== at);
    for (const r of fuzzysort.go(nameWord, targets, { key: "prepName", threshold: 0.2 })) {
      const t = r.obj;
      const lowerPath = t.path.toLowerCase();
      let bonus = 0;
      const pathIndexes: number[] = [];
      let ok = true;
      for (const w of others) {
        const hit = wordIn(lowerPath, w, t.path.length - t.name.length);
        if (!hit) {
          ok = false;
          break;
        }
        bonus += hit.bonus;
        pathIndexes.push(...hit.indexes);
      }
      if (!ok) continue;
      const score = r.score + bonus + lift(t);
      const prev = best.get(t);
      if (!prev || prev.score < score) best.set(t, { target: t, nameIndexes: r.indexes, pathIndexes, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

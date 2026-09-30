/**
 * Reading the helper's tree text: parse it, diff two of them, cut it down to
 * what the agent asked about, and resolve a name to an element index.
 *
 * Watching agents drive Preview showed where the tokens went: every action was
 * followed by a full `get-app-state`, piped through `grep` and `sed -n` to find
 * the three lines that changed. The helper already returns the tree after each
 * action and the tree it saw just before, so the answer to "what did that do"
 * is a diff this module computes, and "where is the Sign button" is a filter.
 *
 * The tree format is the helper's (SnapshotRendering.swift): an envelope, then
 * one line per element as `<tabs><index> <body>`, then a focus sentence.
 * Indexes renumber whenever an element appears above another, so lines are
 * compared by depth and body, never by index.
 */

import { ComputerError } from "./errors.js";

export interface TreeLine {
  /** The element index, or null for a line that names no element (an omission note). */
  index: number | null;
  depth: number;
  /** The line without its tabs and index: `button Sign`. */
  body: string;
  /** Position in its tree, so a run of removed lines can be told to be one subtree. */
  pos: number;
}

export interface ParsedTree {
  lines: TreeLine[];
  /** `The focused UI element is …` (or the none sentence), when present. */
  focus: string | null;
}

const ELEMENT_LINE = /^(\t*)(\d+) (.*)$/;
const OTHER_LINE = /^(\t+)(.*)$/;
const FOCUS_LINE = /^(The focused UI element is |No UI element is currently focused)/;

export function parseTree(treeText: string): ParsedTree {
  const lines: TreeLine[] = [];
  let focus: string | null = null;
  // The envelope is `App=…`, `Window: …` and a blank line; elements start after it.
  const raw = treeText.split("\n");
  const start = raw.findIndex((l) => l === "") + 1;
  for (const line of raw.slice(start)) {
    if (FOCUS_LINE.test(line)) {
      focus = line;
      continue;
    }
    const element = ELEMENT_LINE.exec(line);
    if (element) {
      lines.push({ index: Number(element[2]), depth: element[1].length, body: element[3], pos: lines.length });
      continue;
    }
    const other = OTHER_LINE.exec(line);
    if (other) lines.push({ index: null, depth: other[1].length, body: other[2], pos: lines.length });
  }
  return { lines, focus };
}

export function renderLine(line: TreeLine, indent = "  "): string {
  return `${indent.repeat(line.depth)}${line.index === null ? "" : `${line.index} `}${line.body}`;
}

// ── diff ───────────────────────────────────────────────────────────────────

export interface TreeDiff {
  added: TreeLine[];
  removed: TreeLine[];
  focusBefore: string | null;
  focusAfter: string | null;
}

const key = (l: TreeLine) => `${l.depth}\u0000${l.body}`;

/**
 * Lines added and removed between two trees, in tree order.
 *
 * A longest common subsequence over depth and body, so an element that only
 * moved down because a popover opened above it counts as unchanged. The tree is
 * capped at 1200 nodes by the helper, which keeps the table to about 1.4M cells;
 * past a larger bound it falls back to a multiset difference, which loses order
 * but never the answer to "did anything change".
 */
export function diffTrees(beforeText: string, afterText: string): TreeDiff {
  const before = parseTree(beforeText);
  const after = parseTree(afterText);
  const a = before.lines.map(key);
  const b = after.lines.map(key);
  const n = a.length;
  const m = b.length;
  const added: TreeLine[] = [];
  const removed: TreeLine[] = [];
  if (n * m > 4_000_000) {
    const counts = new Map<string, number>();
    for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const [i, k] of b.entries()) {
      const c = counts.get(k) ?? 0;
      if (c > 0) counts.set(k, c - 1);
      else added.push(after.lines[i]);
    }
    const left = new Map(counts);
    for (const [i, k] of a.entries()) {
      const c = left.get(k) ?? 0;
      if (c > 0) {
        removed.push(before.lines[i]);
        left.set(k, c - 1);
      }
    }
  } else {
    // lcs[i][j] = common length of a[i..] and b[j..], flattened.
    const width = m + 1;
    const lcs = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        removed.push(before.lines[i++]);
      } else {
        added.push(after.lines[j++]);
      }
    }
    while (i < n) removed.push(before.lines[i++]);
    while (j < m) added.push(after.lines[j++]);
  }
  return { added, removed, focusBefore: before.focus, focusAfter: after.focus };
}

/** Past this many changed lines a diff is harder to read than the tree itself. */
export const DIFF_LINE_LIMIT = 60;

/**
 * The diff as the agent reads it. `null` means the change was too large to be
 * worth a diff (a navigation, a new document): print the whole tree instead.
 */
export function formatDiff(diff: TreeDiff): string | null {
  const changed = diff.added.length + diff.removed.length;
  // Compared by index: a focused field whose value changed is already a line above.
  const focusIndex = (f: string | null) => /is (\d+) /.exec(f ?? "")?.[1] ?? f;
  const focusMoved = focusIndex(diff.focusBefore) !== focusIndex(diff.focusAfter);
  if (changed === 0) {
    return focusMoved && diff.focusAfter
      ? `Only the focus changed. ${diff.focusAfter}`
      : "No change in the window's tree. If the action should have changed something, it was probably ignored: try another element, `click --mouse`, or look at a screenshot.";
  }
  if (changed > DIFF_LINE_LIMIT) return null;
  const out = [`Changes: ${diff.added.length} added, ${diff.removed.length} removed`];
  // Removed first, with their old indexes, then added with the indexes to use
  // now. A removed subtree (a popover that closed) is its root and a count:
  // the agent needs to know it went, not to reread what was in it.
  for (let i = 0; i < diff.removed.length; i++) {
    const root = diff.removed[i];
    let j = i + 1;
    while (j < diff.removed.length && diff.removed[j].depth > root.depth && diff.removed[j].pos === root.pos + (j - i)) j++;
    const under = j - i - 1;
    out.push(`- ${renderLine(root)}${under ? `  (and ${under} line${under === 1 ? "" : "s"} under it)` : ""}`);
    i = j - 1;
  }
  for (const l of diff.added) out.push(`+ ${renderLine(l)}`);
  if (focusMoved && diff.focusAfter) out.push(diff.focusAfter);
  return out.join("\n");
}

// ── filters ────────────────────────────────────────────────────────────────

/** Case insensitive substring, or a /regex/i when the query is slash wrapped. */
function matcher(query: string): (text: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (re) {
    const compiled = new RegExp(re[1], re[2].includes("i") ? re[2] : `${re[2]}i`);
    return (text) => compiled.test(text);
  }
  const needle = query.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

/** The indexes of `lines` that are ancestors of line `at` (nearest last). */
function ancestorsOf(lines: TreeLine[], at: number): number[] {
  const chain: number[] = [];
  let depth = lines[at].depth;
  for (let i = at - 1; i >= 0 && depth > 0; i--) {
    if (lines[i].depth < depth) {
      chain.unshift(i);
      depth = lines[i].depth;
    }
  }
  return chain;
}

export interface TreeFilter {
  /** Keep lines matching this text (and their ancestors, for context). */
  find?: string;
  /** Keep only the subtree rooted at this element index. */
  under?: number;
}

/**
 * The lines an agent asked for, with the ancestors that say where each one
 * sits. Returns null when nothing matched, so the caller can say so instead of
 * printing an empty tree.
 */
export function filterTree(treeText: string, filter: TreeFilter): string | null {
  let { lines } = parseTree(treeText);
  if (filter.under !== undefined) {
    const root = lines.findIndex((l) => l.index === filter.under);
    if (root < 0) return null;
    let end = root + 1;
    while (end < lines.length && lines[end].depth > lines[root].depth) end++;
    const base = lines[root].depth;
    lines = lines.slice(root, end).map((l) => ({ ...l, depth: l.depth - base }));
  }
  if (!filter.find) return lines.map((l) => renderLine(l)).join("\n");
  const hit = matcher(filter.find);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!hit(l.body)) return;
    for (const a of ancestorsOf(lines, i)) keep.add(a);
    keep.add(i);
  });
  if (!keep.size) return null;
  return [...keep].sort((x, y) => x - y).map((i) => renderLine(lines[i])).join("\n");
}

// ── element queries ────────────────────────────────────────────────────────

/** The name part of a body: after the role word(s), before the first comma. */
function nameOf(body: string): string {
  return body.split(",")[0].trim().toLowerCase();
}

/**
 * Resolve `--element <query>` to one index.
 *
 * `#56` and `56` are indexes. Anything else is text matched against each
 * element line: an exact match on the role and name (`button Sign`), or on the
 * name alone (`Sign`), beats a substring, so `Sign` finds the Sign button and
 * not every line mentioning a signature. More than one equally good match is an
 * error that lists them, because picking one for the agent is how a click lands
 * on the wrong row. `nth` (1 based) picks among them deliberately.
 */
export function resolveElement(treeText: string, query: string, nth?: number): number {
  const trimmed = query.trim();
  const asIndex = /^#?(\d+)$/.exec(trimmed);
  if (asIndex) return Number(asIndex[1]);
  const elements = parseTree(treeText).lines.filter((l): l is TreeLine & { index: number } => l.index !== null);
  const q = trimmed.toLowerCase();
  const exact = elements.filter((l) => {
    const name = nameOf(l.body);
    return name === q || name.endsWith(` ${q}`);
  });
  const hit = matcher(trimmed);
  const partial = elements.filter((l) => hit(l.body));
  const pool = exact.length ? exact : partial;
  if (!pool.length) {
    throw new ComputerError("element_not_found", `no element matches '${trimmed}'. Run get-app-state --find to see what is there.`);
  }
  if (nth !== undefined) {
    const pick = pool[nth - 1];
    if (!pick) throw new ComputerError("element_not_found", `'${trimmed}' has ${pool.length} matches; --nth ${nth} is past the end`);
    return pick.index;
  }
  if (pool.length > 1) {
    const listed = pool.slice(0, 10).map((l) => `  ${l.index} ${l.body}`);
    const more = pool.length > 10 ? [`  … ${pool.length - 10} more`] : [];
    throw new ComputerError("element_not_found", 
      [`'${trimmed}' matches ${pool.length} elements; pass the index, a more specific query, or --nth:`, ...listed, ...more].join("\n"),
    );
  }
  return pool[0].index;
}

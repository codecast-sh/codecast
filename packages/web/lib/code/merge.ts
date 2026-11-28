// Reconciling two writers of one file: the person in the editor and whoever
// changed it on disk (an agent, a formatter, another window).
//
// Both questions are answered by line, the way git answers them. A character
// diff of two edited versions of a function interleaves their tokens into
// something neither writer wrote; a line diff keeps each writer's lines whole.
//
// @codemirror/merge does the diffing and draws the merge view. It loads only
// when a merge or an external change actually happens (contract 3), so every
// entry point here takes the loaded kit.

import { Prec, StateField, type Extension, type EditorState, type ChangeSpec, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export type MergeKit = typeof import("@codemirror/merge");

let kit: Promise<MergeKit> | null = null;

export function loadMergeKit(): Promise<MergeKit> {
  kit ??= import("@codemirror/merge").catch((e) => {
    kit = null; // a failed chunk load (deploy mid-session) retries next time
    throw e;
  });
  return kit;
}

export interface LineChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/** Bounds the diff on pathological input; past it the result is coarser, not wrong. */
const DIFF_CONFIG = { scanLimit: 20_000, timeout: 400 };

/** Line starts (each line keeps its own terminator) plus the text's length. */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    starts.push(pos);
    lines.push(text.slice(pos, end));
    pos = end;
  }
  starts.push(text.length);
  return { lines, starts };
}

/** Code units usable as one line each, skipping the surrogate range so the
 *  encoded strings stay well formed. */
const MAX_DISTINCT_LINES = 0xffff - 0x800;
const lineChar = (i: number) => String.fromCharCode(i < 0xd800 ? i : i + 0x800);

/**
 * The changes turning `a` into `b`, each covering whole lines, in character
 * offsets. Lines are interned to one code unit apiece and the strings of
 * codes are diffed, so the work is proportional to the line count.
 */
export function lineDiff(merge: MergeKit, a: string, b: string): LineChange[] {
  if (a === b) return [];
  const A = splitLines(a);
  const B = splitLines(b);
  const ids = new Map<string, string>();
  const encode = (lines: string[]) => {
    let out = "";
    for (const line of lines) {
      let id = ids.get(line);
      if (id === undefined) {
        if (ids.size >= MAX_DISTINCT_LINES) return null;
        id = lineChar(ids.size);
        ids.set(line, id);
      }
      out += id;
    }
    return out;
  };
  const ea = encode(A.lines);
  const eb = ea === null ? null : encode(B.lines);
  if (ea === null || eb === null) {
    // More distinct lines than code units: a character diff is still correct.
    return merge.diff(a, b, DIFF_CONFIG).map((c) => ({ fromA: c.fromA, toA: c.toA, fromB: c.fromB, toB: c.toB }));
  }
  return merge.diff(ea, eb, DIFF_CONFIG).map((c) => ({
    fromA: A.starts[c.fromA],
    toA: A.starts[c.toA],
    fromB: B.starts[c.fromB],
    toB: B.starts[c.toB],
  }));
}

/** The smallest set of line edits turning `from` into `to`, as a transaction's changes. */
export function lineChanges(merge: MergeKit, from: string, to: string): ChangeSpec[] {
  return lineDiff(merge, from, to).map((c) => ({ from: c.fromA, to: c.toA, insert: to.slice(c.fromB, c.toB) }));
}

export interface TextRange {
  from: number;
  to: number;
}

export interface ThreeWayResult {
  /** Both sides' changes applied; where they overlap and disagree, mine. */
  text: string;
  /** Regions both sides changed differently. */
  conflicts: number;
  /** Where each conflict sits in `text` (mine's lines, whole). */
  regions: TextRange[];
}

/**
 * Merge `disk` and `mine`, both descended from `base`. Changes only one side
 * made are taken as they are; a region both sides changed the same way is
 * taken once; a region they changed differently keeps mine and counts as a
 * conflict, which the merge view then shows against disk. Edits that touch
 * (one side's change ends where the other's starts) count as overlapping, as
 * in git: two writers on adjacent lines usually meant to coordinate.
 */
export function threeWayMerge(merge: MergeKit, base: string, disk: string, mine: string): ThreeWayResult {
  if (disk === mine) return { text: mine, conflicts: 0, regions: [] };
  if (disk === base) return { text: mine, conflicts: 0, regions: [] };
  if (mine === base) return { text: disk, conflicts: 0, regions: [] };
  const D = lineDiff(merge, base, disk);
  const M = lineDiff(merge, base, mine);
  let out = "";
  let cursor = 0;
  const regions: TextRange[] = [];
  // Running (length of side) - (length of base) over the changes already passed.
  let shiftD = 0;
  let shiftM = 0;
  let i = 0;
  let j = 0;
  while (i < D.length || j < M.length) {
    const takeD = j >= M.length || (i < D.length && D[i].fromA <= M[j].fromA);
    const first = takeD ? D[i] : M[j];
    const start = first.fromA;
    let end = first.toA;
    let groupD = 0;
    let groupM = 0;
    let hasD = false;
    let hasM = false;
    for (;;) {
      if (i < D.length && D[i].fromA <= end) {
        const c = D[i++];
        end = Math.max(end, c.toA);
        groupD += c.toB - c.fromB - (c.toA - c.fromA);
        hasD = true;
      } else if (j < M.length && M[j].fromA <= end) {
        const c = M[j++];
        end = Math.max(end, c.toA);
        groupM += c.toB - c.fromB - (c.toA - c.fromA);
        hasM = true;
      } else break;
    }
    const diskText = disk.slice(start + shiftD, end + shiftD + groupD);
    const mineText = mine.slice(start + shiftM, end + shiftM + groupM);
    out += base.slice(cursor, start);
    if (hasD && !hasM) out += diskText;
    else if (hasM && !hasD) out += mineText;
    else {
      if (diskText !== mineText) regions.push({ from: out.length, to: out.length + mineText.length });
      out += mineText;
    }
    cursor = end;
    shiftD += groupD;
    shiftM += groupM;
  }
  out += base.slice(cursor);
  return { text: out, conflicts: regions.length, regions };
}

/** What the merge view's per-chunk buttons do, in the person's terms: the
 *  editor holds mine, the comparison is disk. */
export const MERGE_LABELS = { accept: "Keep mine", reject: "Take disk" } as const;

// ── the merge view ─────────────────────────────────────────────────────────
//
// The view diffs the editor against disk, so a chunk the person changed
// cleanly and a chunk both sides wrote differently look alike there. The
// conflicts are kept apart: their ranges in the merged text, mapped through
// every later edit, drawn with a red bar, stepped to first, and counted while
// any chunk still differs inside them.

/** Conflict ranges in the merged document. A range grows to cover text
 *  replaced at its edges, so taking disk's side keeps it on its lines. */
const conflictField = StateField.define<readonly TextRange[]>({
  create: () => [],
  update(value, tr) {
    if (!tr.docChanged || !value.length) return value;
    return value.map((r) => {
      const from = tr.changes.mapPos(r.from, -1);
      return { from, to: Math.max(from, tr.changes.mapPos(r.to, 1)) };
    });
  },
});

/** A chunk of the merge view overlaps a conflict range: the conflict is
 *  still a question. An empty range (mine deleted the lines) counts a chunk
 *  that touches it. */
function overlaps(r: TextRange, c: { fromB: number; toB: number }): boolean {
  if (r.from === r.to) return c.fromB <= r.from && c.toB >= r.to;
  return c.fromB < r.to && Math.max(c.toB, c.fromB + 1) > r.from;
}

/** Conflict ranges still differing from disk, in document order. */
export function openConflicts(merge: MergeKit, state: EditorState): TextRange[] {
  const ranges = state.field(conflictField, false);
  const chunks = merge.getChunks(state)?.chunks;
  if (!ranges?.length || !chunks?.length) return [];
  return ranges.filter((r) => chunks.some((c) => overlaps(r, c)));
}

const conflictLine = Decoration.line({ class: "cm-code-mergeConflict" });

function conflictDecorations(merge: MergeKit, state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const r of openConflicts(merge, state)) {
    const a = state.doc.lineAt(r.from).number;
    const end = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    const b = state.doc.lineAt(Math.max(r.from, end)).number;
    for (let n = a; n <= b; n++) out.push(conflictLine.range(state.doc.line(n).from));
  }
  return Decoration.set(out, true);
}

const conflictMarks = (merge: MergeKit) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = conflictDecorations(merge, view.state);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || merge.getChunks(u.startState) !== merge.getChunks(u.state)) this.decorations = conflictDecorations(merge, u.state);
      }
    },
    { decorations: (p) => p.decorations },
  );

const conflictTheme = EditorView.baseTheme({
  ".cm-code-mergeConflict": { boxShadow: "inset 3px 0 0 var(--sol-red)" },
});

/** Move to the next (dir 1) or previous open conflict, wrapping; with none
 *  left, to the next or previous differing chunk. */
export function stepMerge(merge: MergeKit, view: EditorView, dir: 1 | -1): boolean {
  const open = openConflicts(merge, view.state);
  if (!open.length) return (dir === 1 ? merge.goToNextChunk : merge.goToPreviousChunk)(view);
  const head = view.state.selection.main.head;
  const line = (pos: number) => view.state.doc.lineAt(pos).number;
  const cur = line(head);
  const target = dir === 1 ? (open.find((r) => line(r.from) > cur) ?? open[0]) : ([...open].reverse().find((r) => line(r.from) < cur) ?? open[open.length - 1]);
  view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
  return true;
}

/**
 * The editor as a merge view: its document is the merged text, compared
 * against disk, each differing chunk showing disk's lines above mine with a
 * button for each side. The unified view's "accept" keeps the editor's text and
 * "reject" reverts the chunk to the original, which is why disk is the original.
 */
export function mergeViewExtension(merge: MergeKit, disk: string, conflicts: readonly TextRange[] = []): Extension {
  return [conflictField.init(() => conflicts), conflictMarks(merge), conflictTheme, unified(merge, disk), mergeKeys(merge)];
}

/** While a merge is open, Alt-F5 / Shift-Alt-F5 step its conflicts, the
 *  chord that steps git changes outside one (git/gutter.ts), so one key
 *  means "next change" in either. */
const mergeKeys = (merge: MergeKit) =>
  Prec.highest(
    keymap.of([
      { key: "Alt-F5", preventDefault: true, run: (v) => stepMerge(merge, v, 1) },
      { key: "Shift-Alt-F5", preventDefault: true, run: (v) => stepMerge(merge, v, -1) },
    ]),
  );

function unified(merge: MergeKit, disk: string): Extension {
  return merge.unifiedMergeView({
    original: disk,
    gutter: true,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
    collapseUnchanged: { margin: 3, minSize: 8 },
    diffConfig: DIFF_CONFIG,
    mergeControls: (type, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cm-code-merge-${type}`;
      button.textContent = MERGE_LABELS[type];
      button.onmousedown = action;
      return button;
    },
  });
}

/** Chunks still differing from disk; 0 when there is no merge view in the state. */
export function mergeChunkCount(merge: MergeKit, state: EditorState): number {
  return merge.getChunks(state)?.chunks.length ?? 0;
}

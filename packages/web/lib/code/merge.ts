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

import type { Extension, EditorState, ChangeSpec } from "@codemirror/state";

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

export interface ThreeWayResult {
  /** Both sides' changes applied; where they overlap and disagree, mine. */
  text: string;
  /** Regions both sides changed differently. */
  conflicts: number;
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
  if (disk === mine) return { text: mine, conflicts: 0 };
  if (disk === base) return { text: mine, conflicts: 0 };
  if (mine === base) return { text: disk, conflicts: 0 };
  const D = lineDiff(merge, base, disk);
  const M = lineDiff(merge, base, mine);
  let out = "";
  let cursor = 0;
  let conflicts = 0;
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
      out += mineText;
      if (diskText !== mineText) conflicts++;
    }
    cursor = end;
    shiftD += groupD;
    shiftM += groupM;
  }
  out += base.slice(cursor);
  return { text: out, conflicts };
}

/** What the merge view's per-chunk buttons do, in the person's terms: the
 *  editor holds mine, the comparison is disk. */
export const MERGE_LABELS = { accept: "Keep mine", reject: "Take disk" } as const;

/**
 * The editor as a merge view: its document is the merged text, compared
 * against disk, each differing chunk showing disk's lines above mine with a
 * button for each side. The unified view's "accept" keeps the editor's text and
 * "reject" reverts the chunk to the original, which is why disk is the original.
 */
export function mergeViewExtension(merge: MergeKit, disk: string): Extension {
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

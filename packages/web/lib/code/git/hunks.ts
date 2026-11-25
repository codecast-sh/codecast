// Hunks of a file against its git base, in the editor's terms: what kind each
// is, which lines it covers, how to step between them and how to put one back.
// Pure over @codemirror/merge's Chunk (the kit is passed in, so this module
// adds nothing to a bundle by itself).
//
// The first diff of a file is a line diff (merge.lineDiff interns lines, so it
// costs the line count and is exact); later ones update those chunks
// incrementally with Chunk.updateB around the edited region.

import type { ChangeDesc, ChangeSpec, Text } from "@codemirror/state";
import type { Chunk } from "@codemirror/merge";
import { lineDiff, type MergeKit } from "../merge";

export type HunkKind = "added" | "modified" | "deleted";

/** A chunk with positions valid in the current document. */
export interface Hunk {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  kind: HunkKind;
}

/** Bounds a diff on pathological input; past it the result is coarser, not wrong. */
export const GIT_DIFF_CONFIG = { scanLimit: 20_000, timeout: 400 };

/**
 * Chunks turning `base` into `doc`, one per run of changed lines. Chunk ends
 * follow @codemirror/merge's convention: one past the last changed line's
 * terminator, which is past the end of the text when that line has none.
 */
export function buildChunks(kit: MergeKit, base: Text, doc: Text): readonly Chunk[] {
  const a = base.toString();
  const b = doc.toString();
  if (a === b) return [];
  const endOf = (to: number, from: number, text: string) =>
    to > from && to === text.length && !text.endsWith("\n") ? to + 1 : to;
  return lineDiff(kit, a, b).map((c) => {
    const toA = endOf(c.toA, c.fromA, a);
    const toB = endOf(c.toB, c.fromB, b);
    return new kit.Chunk([new kit.Change(0, toA - c.fromA, 0, toB - c.fromB)], c.fromA, toA, c.fromB, toB, true);
  });
}

/** Chunks for `doc` after `changes` (from the document the chunks were built
 *  for), rediffing only around the edits. */
export function updateChunks(kit: MergeKit, chunks: readonly Chunk[], base: Text, doc: Text, changes: ChangeDesc): readonly Chunk[] {
  return kit.Chunk.updateB(chunks, base, doc, changes, GIT_DIFF_CONFIG);
}

export function hunkKind(c: { fromA: number; toA: number; fromB: number; toB: number }): HunkKind {
  if (c.fromA === c.toA) return "added";
  if (c.fromB === c.toB) return "deleted";
  return "modified";
}

/** The chunks as hunks in the current document: edits made since they were
 *  computed (`pending`) shift them until the next diff. */
export function liveHunks(chunks: readonly Chunk[], pending: ChangeDesc | null, docLength: number): Hunk[] {
  return chunks.map((c) => {
    let fromB = c.fromB;
    let toB = c.toB;
    if (pending) {
      fromB = pending.mapPos(Math.min(fromB, pending.length), -1);
      toB = Math.max(fromB, toB > pending.length ? pending.mapPos(pending.length, 1) + (toB - pending.length) : pending.mapPos(toB, 1));
    }
    if (fromB > docLength) fromB = docLength;
    return { fromA: c.fromA, toA: c.toA, fromB, toB, kind: hunkKind(c) };
  });
}

/** First and last document line (1-based) a hunk marks. A deletion marks the
 *  line its lines used to sit above. */
export function hunkLines(h: Hunk, doc: Text): { first: number; last: number } {
  const first = doc.lineAt(Math.min(h.fromB, doc.length)).number;
  if (h.kind === "deleted") return { first, last: first };
  const end = Math.max(h.fromB, Math.min(h.toB - 1, doc.length));
  return { first, last: doc.lineAt(end).number };
}

/** The hunk covering a line, else null. */
export function hunkAtLine(hunks: readonly Hunk[], doc: Text, line: number): Hunk | null {
  for (const h of hunks) {
    const { first, last } = hunkLines(h, doc);
    if (line >= first && line <= last) return h;
    if (first > line) break;
  }
  return null;
}

/** The next (or previous) hunk from a line, wrapping around the file. */
export function stepHunk(hunks: readonly Hunk[], doc: Text, line: number, dir: 1 | -1): Hunk | null {
  if (!hunks.length) return null;
  if (dir === 1) {
    for (const h of hunks) if (hunkLines(h, doc).first > line) return h;
    return hunks[0];
  }
  for (let i = hunks.length - 1; i >= 0; i--) if (hunkLines(hunks[i], doc).last < line) return hunks[i];
  return hunks[hunks.length - 1];
}

/** The base's lines a hunk replaced, without the last terminator. */
export function hunkOldText(h: Hunk, base: Text): string {
  if (h.fromA === h.toA) return "";
  return base.sliceString(h.fromA, Math.max(h.fromA, Math.min(h.toA, base.length + 1) - 1));
}

/** The change that puts a hunk's base lines back. */
export function revertChange(h: Hunk, base: Text, doc: Text): ChangeSpec {
  let insert = hunkOldText(h, base);
  // A run of base lines carries its terminator back, unless it was the base's
  // unterminated last line going back at the end of the document.
  const baseLastLine = h.toA > base.length;
  if (h.fromA !== h.toA && h.toB <= doc.length && !(baseLastLine && h.toB >= doc.length)) insert += "\n";
  return { from: h.fromB, to: Math.min(doc.length, h.toB), insert };
}

/** Lines added and removed by a hunk, for its label. */
export function hunkSize(h: Hunk, base: Text, doc: Text): { added: number; removed: number } {
  const removed = h.fromA === h.toA ? 0 : base.lineAt(Math.min(h.toA - 1, base.length)).number - base.lineAt(h.fromA).number + 1;
  if (h.kind === "deleted") return { added: 0, removed };
  const { first, last } = hunkLines(h, doc);
  return { added: last - first + 1, removed };
}

// The results editor's model, without a view: excerpts of many files stacked
// into one document, and the mapping between that document and the files.
//
// The document is a run of regions, one line or more each, joined by "\n":
//
//   header   the file's path                    read-only
//   excerpt  lines srcStart.. of that file      editable
//   gap      "⋯" between two excerpts of a file read-only
//
// An excerpt is the match lines plus `context` lines around them, merged with
// its neighbours when they touch. Each excerpt remembers the source lines it was
// cut from (`orig`), which is both how a save finds where its text goes and how
// it proves the file still holds those lines there: a save never writes over
// text it did not show.
//
// Positions: an excerpt spans [from, to], from the start of its first line to
// the end of its last, both ends inclusive for edits (typing at the very end of
// the last line belongs to it). Through a change, `from` maps left and `to`
// right, so text inserted at either edge stays inside. Read-only regions only
// move.

import type { ChangeDesc, ChangeSpec, Text } from "@codemirror/state";
import { dominantSeparator, textLines } from "./replace";
import type { FileEdit } from "./writeBack";

export interface ExcerptSource {
  path: string;
  /** The file's text now (any separators). */
  text: string;
  /** 1-based lines to show, with context around them. */
  lines: number[];
}

export type Region =
  | { kind: "header"; from: number; to: number; file: number }
  | { kind: "gap"; from: number; to: number; file: number }
  | {
      kind: "excerpt";
      from: number;
      to: number;
      file: number;
      /** 1-based line in the file of the excerpt's first line. */
      srcStart: number;
      /** The file's lines the excerpt shows, as last read or saved. */
      orig: string[];
    };

export type ExcerptRegion = Extract<Region, { kind: "excerpt" }>;

export interface MultibufferLayout {
  doc: string;
  regions: Region[];
  paths: string[];
}

export const GAP_TEXT = "⋯";

/** 1-based inclusive line ranges around `lines`, merged where they touch. */
export function excerptRanges(lines: number[], lineCount: number, context: number): [number, number][] {
  const sorted = [...new Set(lines)].filter((l) => l >= 1 && l <= lineCount).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const l of sorted) {
    const start = Math.max(1, l - context);
    const end = Math.min(lineCount, l + context);
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** A file's lines. The empty "line" after a final newline is not one: an
 *  excerpt ending there would show a numbered row past the end of the file. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  for (const l of textLines(text)) out.push(l.text);
  if (out.length > 1 && out[out.length - 1] === "" && /[\r\n]$/.test(text)) out.pop();
  return out;
}

export function layoutMultibuffer(sources: ExcerptSource[], context = 2): MultibufferLayout {
  const lines: string[] = [];
  const regions: Region[] = [];
  const paths: string[] = [];
  let pos = 0;
  const push = (text: string) => {
    const from = pos;
    lines.push(text);
    pos += text.length + 1;
    return from;
  };
  for (const src of sources) {
    const fileLines = splitLines(src.text);
    const ranges = excerptRanges(src.lines, fileLines.length, context);
    if (!ranges.length) continue;
    const file = paths.length;
    paths.push(src.path);
    const hFrom = push(src.path);
    regions.push({ kind: "header", from: hFrom, to: hFrom + src.path.length, file });
    ranges.forEach(([start, end], i) => {
      if (i > 0) {
        const g = push(GAP_TEXT);
        regions.push({ kind: "gap", from: g, to: g + GAP_TEXT.length, file });
      }
      const orig = fileLines.slice(start - 1, end);
      const from = pos;
      for (const l of orig) push(l);
      regions.push({ kind: "excerpt", from, to: pos - 1, file, srcStart: start, orig });
    });
  }
  return { doc: lines.join("\n"), regions, paths };
}

/** Regions moved through a change the filter let through. */
export function mapRegions(regions: Region[], changes: ChangeDesc): Region[] {
  if (changes.empty) return regions;
  return regions.map((r) =>
    r.kind === "excerpt"
      ? { ...r, from: changes.mapPos(r.from, -1), to: changes.mapPos(r.to, 1) }
      : { ...r, from: changes.mapPos(r.from, 1), to: changes.mapPos(r.to, 1) },
  );
}

const excerpts = (regions: Region[]) => regions.filter((r): r is ExcerptRegion => r.kind === "excerpt");

/** The region a position sits in (a separator newline belongs to neither side: null). */
export function regionAt(regions: Region[], pos: number): Region | null {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos > r.to) lo = mid + 1;
    else return r;
  }
  return null;
}

export interface RawChange {
  fromA: number;
  toA: number;
  insert: string;
}

/**
 * Keep a transaction's changes inside the excerpts. A change wholly inside one
 * passes (null: nothing to do). One that reaches past an edge is cut to the
 * excerpts it overlaps: its deletion happens inside each, its insertion only
 * where it started inside one. A change wholly on a header or gap is dropped.
 */
export function clipChanges(regions: Region[], changes: RawChange[]): ChangeSpec[] | null {
  const ex = excerpts(regions);
  const inside = (c: RawChange) => ex.some((e) => e.from <= c.fromA && c.toA <= e.to);
  if (changes.every(inside)) return null;
  const out: ChangeSpec[] = [];
  for (const c of changes) {
    if (inside(c)) {
      out.push({ from: c.fromA, to: c.toA, insert: c.insert });
      continue;
    }
    const start = ex.find((e) => e.from <= c.fromA && c.fromA <= e.to);
    if (start) out.push({ from: c.fromA, to: Math.min(c.toA, start.to), insert: c.insert });
    for (const e of ex) {
      if (e === start) continue;
      const from = Math.max(e.from, c.fromA);
      const to = Math.min(e.to, c.toA);
      if (from < to) out.push({ from, to });
    }
  }
  return out;
}

/** An excerpt's text as the document holds it now, by line. */
export function excerptText(doc: Text, e: ExcerptRegion): string[] {
  return doc.sliceString(e.from, e.to).split("\n");
}

export interface ExcerptChange {
  region: ExcerptRegion;
  now: string[];
}

/** Excerpts whose text differs from what they were cut from, by file index. */
export function changedExcerpts(regions: Region[], doc: Text): Map<number, ExcerptChange[]> {
  const out = new Map<number, ExcerptChange[]>();
  for (const e of excerpts(regions)) {
    const now = excerptText(doc, e);
    if (now.length === e.orig.length && now.every((l, i) => l === e.orig[i])) continue;
    const list = out.get(e.file) ?? [];
    list.push({ region: e, now });
    out.set(e.file, list);
  }
  return out;
}

/**
 * The edits that put changed excerpts into a file's current text, or a refusal
 * when the file no longer holds an excerpt's original lines where it was cut.
 * Each line keeps the separator it had (a file with mixed endings keeps them);
 * lines past the excerpt's original count take the file's dominant one.
 */
export function sourceEdits(text: string, changes: ExcerptChange[]): FileEdit[] | { refuse: string } {
  const lines = [...textLines(text)];
  const sep = dominantSeparator(text);
  const edits: FileEdit[] = [];
  for (const { region, now } of changes) {
    const first = lines[region.srcStart - 1];
    const last = lines[region.srcStart - 1 + region.orig.length - 1];
    if (!first || !last) return { refuse: `Lines ${region.srcStart}-${region.srcStart + region.orig.length - 1} are gone` };
    for (let i = 0; i < region.orig.length; i++) {
      if (lines[region.srcStart - 1 + i].text !== region.orig[i]) return { refuse: `Line ${region.srcStart + i} changed on disk` };
    }
    let insert = now[0];
    for (let i = 1; i < now.length; i++) {
      const own = i - 1 < region.orig.length - 1 ? lines[region.srcStart - 1 + i - 1].sep : sep;
      insert += own + now[i];
    }
    edits.push({ from: first.from, to: last.from + last.text.length, insert });
  }
  return edits.sort((a, b) => a.from - b.from);
}

/** The text of each of a file's excerpts, in order: what a save writes and,
 *  once it lands, what those excerpts were cut from. */
export function fileExcerptTexts(regions: Region[], file: number, doc: Text): string[][] {
  return excerpts(regions)
    .filter((e) => e.file === file)
    .map((e) => excerptText(doc, e));
}

/** After a file saved `written` (fileExcerptTexts at save time): its excerpts'
 *  originals become what was written, and each one below a resized excerpt
 *  starts that many lines further down. Text typed during the save stays
 *  unsaved. */
export function rebaseSaved(regions: Region[], file: number, written: string[][]): Region[] {
  let delta = 0;
  let i = 0;
  return regions.map((r) => {
    if (r.kind !== "excerpt" || r.file !== file) return r;
    const now = written[i++] ?? r.orig;
    const next = { ...r, srcStart: r.srcStart + delta, orig: now };
    delta += now.length - r.orig.length;
    return next;
  });
}

/** The file line a document line shows, or null on a header or gap. */
export function sourceLineAt(regions: Region[], doc: Text, pos: number): { file: number; line: number } | null {
  const r = regionAt(regions, pos);
  if (!r || r.kind !== "excerpt") return null;
  return { file: r.file, line: r.srcStart + doc.lineAt(pos).number - doc.lineAt(r.from).number };
}

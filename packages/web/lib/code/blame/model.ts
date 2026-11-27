// Session blame in the editor's terms, pure: the daemon's hunks placed on the
// document, carried through the person's edits until the next fetch, and
// folded into the runs the gutter draws.
//
// A hunk is held as a half-open range of whole lines, [start of its first
// line, start of the line after its last), so an insertion between two hunks
// belongs to neither and a deletion of a hunk's lines empties its range.
// Lines the person has touched since the fetch are held the same way and win
// over any hunk: they are uncommitted now, whoever wrote them before.
//
// No view and no DOM here; the gutter (gutter.ts) and the tests both run it.

import type { ChangeDesc, ChangeSet, Text } from "@codemirror/state";
import type { CodeBlameHunk } from "@codecast/shared/contracts";
import { relTimeShort, formatRelative } from "@codecast/shared/time";
import { SESSION_BLAME_HUES } from "../../repoView";
import { sessionColor } from "../agent/sessions";

/** A range of whole lines: from a line start to the next line's start (or the
 *  document's end). */
export interface LineSpan {
  from: number;
  to: number;
}

export interface PlacedHunk extends LineSpan {
  hunk: CodeBlameHunk;
}

export type RunKind = "session" | "commit" | "uncommitted" | "edited";

/** Consecutive lines drawn as one bar with one label. */
export interface BlameRun {
  /** 1-based, inclusive, in the current document. */
  fromLine: number;
  toLine: number;
  kind: RunKind;
  /** Null for lines edited since the fetch. */
  hunk: CodeBlameHunk | null;
}

// ── placing and mapping ─────────────────────────────────────────────────────

function spanOfLines(doc: Text, first: number, last: number): LineSpan {
  return { from: doc.line(first).from, to: last < doc.lines ? doc.line(last + 1).from : doc.length };
}

/** The daemon's hunks (1-based line numbers of the text it blamed) as ranges
 *  of `doc`, which must be that text. Lines past the end are dropped. */
export function placeHunks(hunks: readonly CodeBlameHunk[], doc: Text): PlacedHunk[] {
  const out: PlacedHunk[] = [];
  for (const hunk of hunks) {
    if (hunk.start < 1 || hunk.start > doc.lines || hunk.end < hunk.start) continue;
    const span = spanOfLines(doc, hunk.start, Math.min(hunk.end, doc.lines));
    if (span.to > span.from) out.push({ ...span, hunk });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** A range through `changes`: text inserted at either edge stays outside it,
 *  and a range whose lines were all deleted is gone (null). */
function mapSpan<T extends LineSpan>(span: T, changes: ChangeDesc): T | null {
  const from = changes.mapPos(span.from, 1);
  const to = changes.mapPos(span.to, -1);
  return to > from ? { ...span, from, to } : null;
}

export function mapHunks(placed: readonly PlacedHunk[], changes: ChangeDesc): PlacedHunk[] {
  const out: PlacedHunk[] = [];
  for (const p of placed) {
    const m = mapSpan(p, changes);
    if (m) out.push(m);
  }
  return out;
}

const atLineStart = (doc: Text, pos: number) => pos === 0 || doc.sliceString(pos - 1, pos) === "\n";
const atLineEnd = (doc: Text, pos: number) => pos === doc.length || doc.sliceString(pos, pos + 1) === "\n";

/**
 * The lines of `doc` (after `changes`, from `startDoc`) whose text the changes
 * altered, as spans. A change that only adds or removes whole lines touches
 * none of its neighbours: `dd` touches nothing, `o` touches the new line and
 * not the one above it, and Enter in the middle of a line touches both halves.
 */
export function touchedSpans(changes: ChangeSet, startDoc: Text, doc: Text): LineSpan[] {
  const out: LineSpan[] = [];
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const text = inserted.toString();
    let first = doc.lineAt(fromB).number;
    let last = doc.lineAt(toB).number;
    const lineAligned = atLineStart(startDoc, fromA) && atLineStart(startDoc, toA) && (text === "" || text.endsWith("\n"));
    const endAligned = atLineEnd(startDoc, fromA) && atLineEnd(startDoc, toA) && (text === "" || text.startsWith("\n"));
    if (lineAligned) {
      if (text === "") return;
      last -= 1;
    } else if (endAligned) {
      if (text === "") return;
      first += 1;
    }
    if (last < first) return;
    const span = spanOfLines(doc, first, last);
    if (span.to > span.from) out.push(span);
  });
  return out;
}

/** Sorted, overlapping or touching spans merged. */
export function mergeSpans(spans: readonly LineSpan[]): LineSpan[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: LineSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}

/** The edited spans after a transaction: the old ones carried through it,
 *  plus the lines it touched. */
export function updateEdits(edits: readonly LineSpan[], changes: ChangeSet, startDoc: Text, doc: Text): LineSpan[] {
  const mapped: LineSpan[] = [];
  for (const e of edits) {
    const m = mapSpan(e, changes);
    if (m) mapped.push(m);
  }
  return mergeSpans([...mapped, ...touchedSpans(changes, startDoc, doc)]);
}

// ── runs ────────────────────────────────────────────────────────────────────

export function hunkKind(hunk: CodeBlameHunk): Exclude<RunKind, "edited"> {
  if (hunk.uncommitted) return "uncommitted";
  return hunk.session ? "session" : "commit";
}

const EDITED = -2;
const NONE = -1;

/** Every line's run: edited lines first, then the hunk covering the line.
 *  Lines no hunk covers (a trailing empty line) belong to no run. */
export function blameRuns(placed: readonly PlacedHunk[], edits: readonly LineSpan[], doc: Text): BlameRun[] {
  const owner = new Int32Array(doc.lines + 1).fill(NONE);
  const fill = (span: LineSpan, value: number) => {
    const first = doc.lineAt(span.from).number;
    const last = doc.lineAt(Math.max(span.from, span.to - 1)).number;
    owner.fill(value, first, last + 1);
  };
  placed.forEach((p, i) => fill(p, i));
  for (const e of edits) fill(e, EDITED);
  const runs: BlameRun[] = [];
  let line = 1;
  while (line <= doc.lines) {
    const o = owner[line];
    let end = line;
    while (end < doc.lines && owner[end + 1] === o) end++;
    if (o === EDITED) runs.push({ fromLine: line, toLine: end, kind: "edited", hunk: null });
    else if (o !== NONE) runs.push({ fromLine: line, toLine: end, kind: hunkKind(placed[o].hunk), hunk: placed[o].hunk });
    line = end + 1;
  }
  return runs;
}

/** The run holding a line, by binary search. */
export function runAtLine(runs: readonly BlameRun[], line: number): BlameRun | null {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (line < r.fromLine) hi = mid - 1;
    else if (line > r.toLine) lo = mid + 1;
    else return r;
  }
  return null;
}

function spanAt<T extends LineSpan>(spans: readonly T[], pos: number): T | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (pos < s.from) hi = mid - 1;
    else if (pos >= s.to) lo = mid + 1;
    else return s;
  }
  return null;
}

/** What wrote the line at `pos` right now, without building runs: what inline
 *  blame reads on every cursor move. Null when nothing is known. */
export function originAt(placed: readonly PlacedHunk[], edits: readonly LineSpan[], pos: number): { kind: RunKind; hunk: CodeBlameHunk | null } | null {
  if (spanAt(edits, pos)) return { kind: "edited", hunk: null };
  // Hunks stay sorted through mapping; overlaps after a join resolve to the
  // later one, as blameRuns does.
  const p = spanAt(placed, pos);
  return p ? { kind: hunkKind(p.hunk), hunk: p.hunk } : null;
}

// ── labels and colors ───────────────────────────────────────────────────────

export const UNCOMMITTED_LABEL = "Uncommitted";

/** The name a run is labelled with: the session's title, or the commit's
 *  author when no session is known. */
export function runName(kind: RunKind, hunk: CodeBlameHunk | null): string {
  if (kind === "edited" || !hunk) return UNCOMMITTED_LABEL;
  const s = hunk.session;
  if (s) return s.title?.trim() || `Session ${s.id}`;
  if (hunk.uncommitted) return UNCOMMITTED_LABEL;
  if (hunk.sweep_sessions) return `${hunk.sweep_sessions} sessions`;
  return hunk.author?.trim() || hunk.sha?.slice(0, 7) || "Unknown";
}

/** The gutter label: a name and a short age ("3h"), the age empty when the
 *  time is unknown and "now" for lines edited since the fetch. */
export function runLabel(kind: RunKind, hunk: CodeBlameHunk | null, now: number): { name: string; age: string } {
  const name = runName(kind, hunk);
  if (kind === "edited") return { name, age: "now" };
  return { name, age: hunk?.time ? relTimeShort(hunk.time, Math.max(now, hunk.time)) : "" };
}

/** The inline text at the end of the cursor line: "Fix the auth race, 3h ago",
 *  with the commit summary after a plain commit's author. */
export function inlineText(kind: RunKind, hunk: CodeBlameHunk | null, now: number): string {
  const name = runName(kind, hunk);
  if (kind === "edited" || !hunk) return name;
  const when = hunk.time ? formatRelative(hunk.time, Math.max(now, hunk.time)) : "";
  const head = when ? `${name}, ${when}` : name;
  return kind === "commit" && hunk.summary ? `${head} · ${hunk.summary}` : head;
}

/** Bars of lines no session wrote. */
export const NEUTRAL_HUE = "var(--sol-text-dim)";

/**
 * Session id to color for one file: each session's own color (sessionColor:
 * its icon color, else a hue fixed by its id), the one every agent surface in
 * the editor draws it in, so a line's blame bar matches the live edit bar,
 * the presence dot and the chip of the session that wrote it. `iconOf` reads
 * a session's icon color where the caller has the rows.
 */
export function sessionHues(hunks: readonly CodeBlameHunk[], iconOf: (id: string) => string | undefined = () => undefined): Map<string, string> {
  const hues = new Map<string, string>();
  for (const h of hunks) {
    const s = h.session;
    const id = s?.conversation_id ?? s?.id;
    if (id && !hues.has(id)) hues.set(id, sessionColor({ _id: id, icon_color: iconOf(id) }));
  }
  return hues;
}

export function hueOf(hunk: CodeBlameHunk | null, hues: ReadonlyMap<string, string>): string {
  const s = hunk?.session;
  const id = s?.conversation_id ?? s?.id;
  return (id && hues.get(id)) || NEUTRAL_HUE;
}

export { SESSION_BLAME_HUES };

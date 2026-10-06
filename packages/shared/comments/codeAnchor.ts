import { MIN_LINE_MATCH_LEN } from "../blame";

// A comment on a line of code is stored at a file and line, but a line number
// only means something in the version of the file it was read from. Once the
// code moves on (lines added above, the passage edited, the branch pushed), the
// number points at whatever sits there now. So every line comment also keeps
// the text it was written on, and a reader finds the passage again by content,
// the way `cast blame` finds uncommitted lines: trimmed text, equal or not.
//
// The thread keeps its identity (file and line at the ref); only where it is
// drawn follows the code.

/** The commented lines and up to two lines either side, each trimmed. */
export type CodeAnchorText = {
  before: string[];
  lines: string[];
  after: string[];
};

export const ANCHOR_CONTEXT_LINES = 2;
export const ANCHOR_MAX_LINES = 12;
export const ANCHOR_MAX_LINE_CHARS = 160;
export const ANCHOR_MAX_BYTES = 2048;

const clip = (line: string) => line.trim().slice(0, ANCHOR_MAX_LINE_CHARS);
const squash = (line: string) => clip(line).replace(/\s+/g, "");
const byteSize = (text: CodeAnchorText) => new TextEncoder().encode(JSON.stringify(text)).length;

/**
 * The anchor for lines `start..end` (1-based, inclusive) of a file, or
 * undefined when the first line is not in it. `fileLines` may have holes (a
 * diff shows only its hunks): context stops at the first line the caller
 * cannot see. Capped at 12 lines and 2 KB: the context goes first, then the
 * tail of a long range.
 */
export function captureAnchor(
  fileLines: readonly (string | undefined)[],
  start: number,
  end: number = start,
): CodeAnchorText | undefined {
  if (!Number.isInteger(start) || start < 1 || fileLines[start - 1] === undefined) return undefined;
  const at = (n: number) => fileLines[n - 1];
  const lines: string[] = [];
  let last = start;
  for (let n = start; n <= Math.max(end, start) && at(n) !== undefined; n++) {
    lines.push(clip(at(n)!));
    last = n;
  }
  const before: string[] = [];
  for (let n = start - 1; n >= 1 && before.length < ANCHOR_CONTEXT_LINES && at(n) !== undefined; n--) before.unshift(clip(at(n)!));
  const after: string[] = [];
  for (let n = last + 1; after.length < ANCHOR_CONTEXT_LINES && at(n) !== undefined; n++) after.push(clip(at(n)!));
  const text: CodeAnchorText = { before, lines: lines.slice(0, ANCHOR_MAX_LINES - 2 * ANCHOR_CONTEXT_LINES), after };
  while (byteSize(text) > ANCHOR_MAX_BYTES && (text.before.length || text.after.length)) {
    text.before.shift();
    text.after.pop();
  }
  while (byteSize(text) > ANCHOR_MAX_BYTES && text.lines.length > 1) text.lines.pop();
  return text;
}

/**
 * The anchor for a GitHub review comment, from the `diff_hunk` GitHub sends
 * with it. The hunk ends at the commented line, so it carries the lines above
 * as context and nothing below. `span` is how many lines the comment covers.
 */
export function anchorFromDiffHunk(hunk: string | null | undefined, side: string | null | undefined, span = 1): CodeAnchorText | undefined {
  if (!hunk) return undefined;
  const drop = side === "LEFT" ? "+" : "-";
  const sideLines = hunk.split("\n")
    .filter((line) => !line.startsWith("@@") && !line.startsWith("\\") && !line.startsWith(drop))
    .map((line) => line.slice(1));
  if (sideLines.length === 0) return undefined;
  const count = Math.min(Math.max(1, span), sideLines.length, ANCHOR_MAX_LINES - ANCHOR_CONTEXT_LINES);
  const startAt = sideLines.length - count;
  return captureAnchor(sideLines, startAt + 1, sideLines.length);
}

function findAll(
  fileLines: readonly (string | undefined)[],
  needle: string[],
  norm: (line: string) => string,
): number[] {
  if (needle.length === 0) return [];
  const want = needle.map(norm);
  const found: number[] = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) {
      const line = fileLines[i + j];
      ok = line !== undefined && norm(line) === want[j];
    }
    if (ok) found.push(i);
  }
  return found;
}

// A commented passage without its context is only worth matching when it is
// distinctive: `}` or a blank line is everywhere. Same floor as blame.
const distinctive = (lines: string[]) => lines.join("").trim().length >= MIN_LINE_MATCH_LEN;

/**
 * Where the commented passage is in `fileLines` now (1-based), or null when it
 * is gone. `fileLines[i]` is line i + 1; an undefined entry is a line the
 * caller cannot see (a diff shows only its hunks). Tries, in order: the whole
 * anchor exactly, the commented lines alone, then both ignoring whitespace.
 * Among several matches the one nearest the old line wins.
 */
export function relocateAnchor(
  anchor: { line: number; text: CodeAnchorText },
  fileLines: readonly (string | undefined)[],
): number | null {
  const { before, lines, after } = anchor.text;
  if (lines.length === 0) return null;
  const window = [...before, ...lines, ...after];
  const tiers: Array<[string[], (line: string) => string, number]> = [
    [window, clip, before.length],
    ...(distinctive(lines) ? [[lines, clip, 0] as [string[], (line: string) => string, number]] : []),
    [window, squash, before.length],
    ...(distinctive(lines) ? [[lines, squash, 0] as [string[], (line: string) => string, number]] : []),
  ];
  for (const [needle, norm, offset] of tiers) {
    const starts = findAll(fileLines, needle, norm).map((i) => i + offset + 1);
    if (starts.length === 0) continue;
    return starts.reduce((best, line) =>
      Math.abs(line - anchor.line) < Math.abs(best - anchor.line) ? line : best);
  }
  return null;
}

export type AnchorPlacement =
  /** The passage is where the comment says, or the comment has no text to check. */
  | { state: "current"; line: number; lineEnd?: number }
  | { state: "moved"; line: number; lineEnd?: number; from: number }
  /** The passage is gone; drawn at its old line with the original text quoted. */
  | { state: "outdated"; line: number; lineEnd?: number; from: number };

/** Where to draw a comment written at `line` (to `lineEnd`) against `fileLines`. */
export function placeAnchor(
  comment: { line_number?: number | null; line_end?: number | null; anchor_lines?: CodeAnchorText | null },
  fileLines: readonly (string | undefined)[],
): AnchorPlacement | null {
  const line = comment.line_number;
  if (!line) return null;
  const lineEnd = comment.line_end && comment.line_end !== line ? comment.line_end : undefined;
  if (!comment.anchor_lines?.lines.length) return { state: "current", line, lineEnd };
  const found = relocateAnchor({ line, text: comment.anchor_lines }, fileLines);
  if (found === null) return { state: "outdated", line, lineEnd, from: line };
  if (found === line) return { state: "current", line, lineEnd };
  return { state: "moved", line: found, lineEnd: lineEnd && lineEnd + (found - line), from: line };
}

/** "moved from line 12" | "outdated" | "", for headers and CLI listings. */
export function placementLabel(placement: AnchorPlacement | null): string {
  if (placement?.state === "moved") return `moved from line ${placement.from}`;
  if (placement?.state === "outdated") return "outdated";
  return "";
}

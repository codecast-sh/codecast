// Pure patch parsing now lives in @codecast/convex so it can be shared with the
// server-side file-change materializer. This module re-exports it and keeps the
// web-only presentation helper (getFileStatus) local.
export { parsePatch } from "@codecast/convex/convex/fileChanges/patchParser";
export type { PatchHunk, PatchLine, ParsedPatch } from "@codecast/convex/convex/fileChanges/patchParser";

export function getFileStatus(status: string): {
  label: string;
  color: string;
  bgColor: string;
} {
  switch (status.toLowerCase()) {
    case "added":
      return { label: "A", color: "text-sol-green", bgColor: "bg-sol-green/20" };
    case "removed":
    case "deleted":
      return { label: "D", color: "text-sol-red", bgColor: "bg-sol-red/20" };
    case "modified":
      return { label: "M", color: "text-sol-yellow", bgColor: "bg-sol-yellow/20" };
    case "renamed":
      return { label: "R", color: "text-sol-cyan", bgColor: "bg-sol-cyan/20" };
    case "copied":
      return { label: "C", color: "text-sol-violet", bgColor: "bg-sol-violet/20" };
    default:
      return { label: "?", color: "text-sol-text-muted", bgColor: "bg-sol-text-muted/20" };
  }
}

// Which side of a diff a line belongs to: LEFT is the file before the change,
// RIGHT the file after. GitHub names the sides this way on a review comment,
// and a comment is anchored to a side as well as a line, because the same
// number means two different lines on the two sides.
export type DiffSide = "LEFT" | "RIGHT";

/**
 * The anchor a line thread hangs on: one line, or a run of lines when the
 * reader selected several before commenting. `lineNumber` is the first line
 * either way, so a single line anchor is a range of one and nothing has to
 * branch on which kind it is.
 */
export type DiffLineAnchor = { side: DiffSide; lineNumber: number; lineEnd?: number };

/** One string key for an anchor, so a Map can hold both sides of a line and a
 *  range on a line can sit beside a comment on the line alone. */
export function diffLineKey(anchor: DiffLineAnchor): string {
  const end = anchor.lineEnd;
  return end !== undefined && end !== anchor.lineNumber
    ? `${anchor.side}:${anchor.lineNumber}-${end}`
    : `${anchor.side}:${anchor.lineNumber}`;
}

export function parseDiffLineKey(key: string): DiffLineAnchor {
  const [side, span] = key.split(":");
  const [start, end] = (span ?? "").split("-");
  const anchor: DiffLineAnchor = {
    side: side === "LEFT" ? "LEFT" : "RIGHT",
    lineNumber: Number(start),
  };
  if (end !== undefined) anchor.lineEnd = Number(end);
  return anchor;
}

/** The row a thread renders under: the LAST line it covers, so a range hangs
 *  below the code it is about rather than splitting it. */
export function anchorEndLine(anchor: DiffLineAnchor): number {
  return anchor.lineEnd ?? anchor.lineNumber;
}

// -- Line selection -----------------------------------------------------------
//
// Shared by the source browser (a run of lines in a file) and by a diff (a run
// of rows on one side). Both select the same way: click to anchor, shift click
// to extend from where the selection started.

export type LineRange = { start: number; end: number };

/** Extend a selection to a shift-clicked line, anchored on where it started. */
export function extendLineRange(current: LineRange | null, line: number): LineRange {
  if (!current) return { start: line, end: line };
  return { start: Math.min(current.start, line), end: Math.max(current.start, line) };
}

export function isLineSelected(range: LineRange | null, line: number): boolean {
  return !!range && line >= range.start && line <= range.end;
}

/** The end of a comment's anchor: the selection's last line when the composer
 *  opened inside a multi-line selection, and nothing when it is one line. */
export function commentRangeEnd(selection: LineRange | null, line: number): number | undefined {
  if (!selection || selection.start === selection.end) return undefined;
  return line >= selection.start && line <= selection.end ? selection.end : undefined;
}

/** The side a comment with no explicit side belongs to. GitHub defaults an
 *  unsided comment to the file after the change. */
export const DEFAULT_DIFF_SIDE: DiffSide = "RIGHT";

export function normalizeDiffSide(side: string | undefined): DiffSide {
  return (side ?? "").toUpperCase() === "LEFT" ? "LEFT" : DEFAULT_DIFF_SIDE;
}

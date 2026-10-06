// Where a line comment sits in a diff once the code has moved on.
//
// A diff shows only its hunks, so the file it reads is full of holes. The
// passage is looked for among the lines the diff shows (shared/comments
// codeAnchor): found, the thread hangs there; not found, it is outdated only
// when its old line is on screen to carry it, and otherwise stays off the
// diff as it always did, because a passage outside every hunk may simply be
// unchanged and out of view.
import { captureAnchor, placeAnchor, type AnchorPlacement, type CodeAnchorText } from "@codecast/shared/comments";

type DiffRow = { type: string; content?: string; oldNum?: number; newNum?: number };
export type DiffSide = "LEFT" | "RIGHT";

/** One side of the diff as a sparse file: `lines[n - 1]` is line n, if shown. */
export function diffSideLines(rows: readonly DiffRow[], side: DiffSide): (string | undefined)[] {
  const lines: (string | undefined)[] = [];
  for (const row of rows) {
    if (row.type === "separator") continue;
    const num = side === "LEFT" ? (row.type === "added" ? undefined : row.oldNum) : (row.type === "removed" ? undefined : row.newNum);
    if (num) lines[num - 1] = row.content ?? "";
  }
  return lines;
}

/** The anchor to store for a comment written on `start..end` of one side of a diff. */
export function captureDiffAnchor(rows: readonly DiffRow[], side: DiffSide, start: number, end?: number): CodeAnchorText | undefined {
  return captureAnchor(diffSideLines(rows, side), start, end);
}

export type DiffPlacement = AnchorPlacement & { side: DiffSide };

/**
 * Where to draw a comment in this diff, or null when the diff cannot show it.
 * `side` is the comment's own side when it has one; a sideless comment (a
 * session's durable thread) is looked for on the new side, then the old.
 */
export function placeInDiff(
  rows: readonly DiffRow[],
  comment: { line_number?: number | null; line_end?: number | null; side?: string | null; anchor_lines?: CodeAnchorText | null },
): DiffPlacement | null {
  const sides: DiffSide[] = comment.side === "LEFT" ? ["LEFT"] : comment.side === "RIGHT" ? ["RIGHT"] : ["RIGHT", "LEFT"];
  let outdated: DiffPlacement | null = null;
  for (const side of sides) {
    const lines = diffSideLines(rows, side);
    const placement = placeAnchor(comment, lines);
    if (!placement) return null;
    const shown = lines[(placement.lineEnd ?? placement.line) - 1] !== undefined || lines[placement.line - 1] !== undefined;
    if (placement.state !== "outdated") {
      if (shown) return { ...placement, side };
      continue;
    }
    if (!outdated && shown) outdated = { ...placement, side };
  }
  return outdated;
}

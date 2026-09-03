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

/** The anchor a line thread hangs on. */
export type DiffLineAnchor = { side: DiffSide; lineNumber: number };

/** One string key for an anchor, so a Map can hold both sides of a line. */
export function diffLineKey(anchor: DiffLineAnchor): string {
  return `${anchor.side}:${anchor.lineNumber}`;
}

export function parseDiffLineKey(key: string): DiffLineAnchor {
  const [side, line] = key.split(":");
  return { side: side === "LEFT" ? "LEFT" : "RIGHT", lineNumber: Number(line) };
}

/** The side a comment with no explicit side belongs to. GitHub defaults an
 *  unsided comment to the file after the change. */
export const DEFAULT_DIFF_SIDE: DiffSide = "RIGHT";

export function normalizeDiffSide(side: string | undefined): DiffSide {
  return (side ?? "").toUpperCase() === "LEFT" ? "LEFT" : DEFAULT_DIFF_SIDE;
}

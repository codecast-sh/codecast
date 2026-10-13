// Line comments read against the code on this machine.
//
// A comment keeps the text it was written on (shared/comments/codeAnchor.ts).
// Writing one from a checkout captures that text from the file; listing them
// finds each passage again in the file as it is now, so `cast review ls` and
// `cast pr threads` print where the code is rather than where it was.

import fs from "fs";
import path from "path";
import { execFileSync } from "./proc.js";
import { captureAnchor, placeAnchor, type AnchorPlacement, type CodeAnchorText } from "@codecast/shared/comments";

const LARGEST_FILE = 4 * 1024 * 1024;

/** The file's lines in the working tree, or at `ref` when given. Null when unreadable. */
export function readFileLines(repoRoot: string, relPath: string, ref?: string | null): string[] | null {
  try {
    const text = ref
      ? execFileSync("git", ["show", `${ref}:${relPath}`], {
          cwd: repoRoot,
          encoding: "utf8",
          maxBuffer: LARGEST_FILE,
          stdio: ["ignore", "pipe", "ignore"],
        })
      : fs.statSync(path.join(repoRoot, relPath)).size > LARGEST_FILE
        ? null
        : fs.readFileSync(path.join(repoRoot, relPath), "utf8");
    return text === null ? null : text.replace(/\n$/, "").split("\n");
  } catch {
    return null;
  }
}

/** The anchor to store with a comment on `start..end` of a file in this checkout. */
export function captureLocalAnchor(repoRoot: string, relPath: string, start?: number, end?: number): CodeAnchorText | undefined {
  if (!start) return undefined;
  const lines = readFileLines(repoRoot, relPath);
  return lines ? captureAnchor(lines, start, end) : undefined;
}

type Placeable = { file_path?: string | null; line_number?: number | null; line_end?: number | null; anchor_lines?: CodeAnchorText | null };

/**
 * The comments whose passage moved or is gone in the files as `readLines`
 * returns them. A comment still on its line, with no stored text, or on a file
 * that cannot be read is left out: there is nothing to say about it.
 */
export function placeComments<T extends Placeable>(
  comments: T[],
  readLines: (filePath: string) => string[] | null,
): Map<T, AnchorPlacement> {
  const files = new Map<string, string[] | null>();
  const placed = new Map<T, AnchorPlacement>();
  for (const comment of comments) {
    if (!comment.file_path || !comment.anchor_lines?.lines.length) continue;
    if (!files.has(comment.file_path)) files.set(comment.file_path, readLines(comment.file_path));
    const lines = files.get(comment.file_path);
    if (!lines) continue;
    const placement = placeAnchor(comment, lines);
    if (placement && placement.state !== "current") placed.set(comment, placement);
  }
  return placed;
}

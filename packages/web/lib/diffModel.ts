// The one place a diff becomes hunks: what DiffView's rows come from, and the
// patch @pierre/diffs is handed to draw.
//
// A diff reaches DiffView in three shapes: a pull request's parsed hunks, a
// whole file before and after (line 1 onward), or a snippet of a file that
// starts somewhere in the middle (an agent's Edit, a Read result). Each becomes
// hunks with the file's real line numbers. A whole file also keeps both texts,
// so Pierre can open the unchanged stretches between hunks; a snippet has no
// rest of the file to open.
//
// Comment placement, anchor capture and truncation read the rows, and Pierre
// draws the patch written from the same hunks, so the two cannot disagree
// about which line is where. Nothing here imports Pierre: it loads only when
// a diff is drawn (components/diff/pierre.ts).
import { structuredPatch } from "diff";
import type { PatchHunk, PatchLine } from "./patchParser";

export type DiffRowType = "added" | "removed" | "context";
export type DiffRow = { type: DiffRowType; content: string; oldNum?: number; newNum?: number; hidden?: boolean };

export type DiffInput = {
  oldStr?: string;
  newStr?: string;
  hunks?: PatchHunk[];
  startLine?: number;
  contextLines?: number;
};

export type DiffModel = {
  hunks: PatchHunk[];
  /** Both texts, when the diff is a whole file. */
  whole?: { oldStr: string; newStr: string };
};

// Past this many edits the minimal diff costs seconds (Myers is O(N·D)), and
// a change that large reads as a rewrite anyway: show it as one.
const MAX_EDIT_LENGTH = 2000;

export function buildDiffModel({ oldStr = "", newStr = "", hunks, startLine = 1, contextLines = 3 }: DiffInput): DiffModel {
  if (hunks && hunks.length > 0) return { hunks };
  const built = stringHunks(oldStr, newStr, startLine, contextLines);
  return startLine === 1 && oldStr !== newStr ? { hunks: built, whole: { oldStr, newStr } } : { hunks: built };
}

// Hunks for two texts, numbered from the line they start on. Identical text (a
// Read result) is one hunk of context, so every line is shown and numbered.
function stringHunks(oldStr: string, newStr: string, startLine: number, contextLines: number): PatchHunk[] {
  if (oldStr === newStr) {
    const lines = splitLines(newStr);
    return [numbered(startLine, startLine, lines.map((l) => ` ${l}`))];
  }
  const patch = structuredPatch("a", "b", ensureNewline(oldStr), ensureNewline(newStr), "", "", {
    context: contextLines,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  const shift = startLine - 1;
  if (!patch) {
    const removed = oldStr === "" ? [] : splitLines(oldStr).map((l) => `-${l}`);
    const added = newStr === "" ? [] : splitLines(newStr).map((l) => `+${l}`);
    return [numbered(startLine, startLine, [...removed, ...added])];
  }
  return patch.hunks.map((h) =>
    numbered(h.oldStart + shift, h.newStart + shift, h.lines.filter((l) => !l.startsWith("\\"))),
  );
}

// One hunk from unified-diff body lines, numbered from its two starts.
function numbered(oldStart: number, newStart: number, body: string[]): PatchHunk {
  let oldNum = oldStart;
  let newNum = newStart;
  const lines: PatchLine[] = body.map((l) => {
    const content = l.slice(1);
    if (l[0] === "+") return { type: "addition", content, newLineNumber: newNum++ };
    if (l[0] === "-") return { type: "deletion", content, oldLineNumber: oldNum++ };
    return { type: "context", content, oldLineNumber: oldNum++, newLineNumber: newNum++ };
  });
  const oldCount = oldNum - oldStart;
  const newCount = newNum - newStart;
  // A side with no lines names the line before the hunk, as unified diffs do.
  return { oldStart: oldCount ? oldStart : oldStart - 1, oldCount, newStart: newCount ? newStart : newStart - 1, newCount, lines };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function ensureNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** The model as a one-file unified patch, the form Pierre parses. */
export function diffPatchText(model: DiffModel, name: string): string {
  const body = model.hunks.map((h) =>
    `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n` +
    h.lines.map((l) => `${l.type === "addition" ? "+" : l.type === "deletion" ? "-" : " "}${l.content}\n`).join(""),
  );
  return `--- ${name}\n+++ ${name}\n${body.join("")}`;
}

/**
 * Every row of the diff, in order, with its line numbers on each side. A whole
 * file also yields the unchanged stretches its hunks leave out, marked
 * `hidden`, because the reader can open them and comment there; the rows of a
 * snippet or a patch are exactly its hunks.
 */
export function diffRows(model: DiffModel): DiffRow[] {
  const rows: DiffRow[] = [];
  const newLines = model.whole ? splitLines(model.whole.newStr) : [];
  // The next line on each side that no row has covered yet.
  let nextOld = 1;
  let nextNew = 1;
  const unchanged = (upToNew: number) => {
    for (; nextNew < upToNew; nextNew++, nextOld++) {
      rows.push({ type: "context", content: newLines[nextNew - 1] ?? "", oldNum: nextOld, newNum: nextNew, hidden: true });
    }
  };
  for (const hunk of model.hunks) {
    if (model.whole) unchanged(hunk.newCount ? hunk.newStart : hunk.newStart + 1);
    for (const l of hunk.lines) {
      if (l.type === "addition") rows.push({ type: "added", content: l.content, newNum: l.newLineNumber });
      else if (l.type === "deletion") rows.push({ type: "removed", content: l.content, oldNum: l.oldLineNumber });
      else rows.push({ type: "context", content: l.content, oldNum: l.oldLineNumber, newNum: l.newLineNumber });
      if (l.oldLineNumber !== undefined) nextOld = l.oldLineNumber + 1;
      if (l.newLineNumber !== undefined) nextNew = l.newLineNumber + 1;
    }
  }
  if (model.whole) unchanged(newLines.length + 1);
  return rows;
}

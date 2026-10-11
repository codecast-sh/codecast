// The one place a diff becomes the model @pierre/diffs renders, and the rows
// our comment code reads back out of it.
//
// A diff reaches DiffView in three shapes: a pull request's parsed hunks, a
// whole file before and after (line 1 onward), or a snippet of a file that
// starts somewhere in the middle (an agent's Edit, a Read result). The whole
// file goes to Pierre as two files, so it can expand hidden context itself.
// The other two become a patch with the file's real line numbers; a snippet
// has no rest of the file to expand into, so its hidden context stays hidden.
//
// Comment placement and anchor capture need the rows the diff shows, with
// their old and new line numbers. Those are derived from the same metadata
// Pierre draws, so the two can never disagree about which line is where.
import { parseDiffFromFile, processFile, type FileDiffMetadata } from "@pierre/diffs";
import { structuredPatch } from "diff";
import type { PatchHunk } from "./patchParser";

export type DiffRowType = "added" | "removed" | "context";
export type DiffRow = { type: DiffRowType; content: string; oldNum?: number; newNum?: number };

export type DiffInput = {
  oldStr?: string;
  newStr?: string;
  hunks?: PatchHunk[];
  startLine?: number;
  contextLines?: number;
  /** A path, for the header and for language inference. */
  name: string;
  /** A Shiki language id or alias; overrides inference from `name`. */
  lang?: string;
};

export function buildDiffMetadata(input: DiffInput): FileDiffMetadata {
  const { oldStr = "", newStr = "", hunks, startLine = 1, contextLines = 3, name, lang } = input;
  let meta: FileDiffMetadata | undefined;
  if (hunks && hunks.length > 0) {
    meta = processFile(patchText(name, hunks.map(hunkText)));
  } else if (startLine === 1 && oldStr !== newStr) {
    meta = parseDiffFromFile({ name, contents: oldStr }, { name, contents: newStr }, { context: contextLines });
  } else {
    meta = processFile(patchText(name, snippetHunks(oldStr, newStr, startLine, contextLines)));
  }
  if (!meta) throw new Error(`diff for ${name} did not parse`);
  if (lang) meta.lang = lang;
  return meta;
}

function patchText(name: string, hunks: string[]): string {
  return `--- ${name}\n+++ ${name}\n${hunks.join("")}`;
}

function header(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
}

function hunkText(h: PatchHunk): string {
  const body = h.lines
    .map((l) => `${l.type === "addition" ? "+" : l.type === "deletion" ? "-" : " "}${l.content}\n`)
    .join("");
  return header(h.oldStart, h.oldCount, h.newStart, h.newCount) + body;
}

// A snippet's hunks, numbered from the line it starts on. Identical text (a
// Read result) is one hunk of context, so every line is shown and numbered.
function snippetHunks(oldStr: string, newStr: string, startLine: number, contextLines: number): string[] {
  const shift = startLine - 1;
  if (oldStr === newStr) {
    const lines = splitLines(newStr);
    return [header(startLine, lines.length, startLine, lines.length) + lines.map((l) => ` ${l}\n`).join("")];
  }
  const patch = structuredPatch("a", "b", ensureNewline(oldStr), ensureNewline(newStr), "", "", { context: contextLines });
  return patch.hunks.map((h) =>
    header(h.oldStart + (h.oldLines ? shift : 0), h.oldLines, h.newStart + (h.newLines ? shift : 0), h.newLines) +
    h.lines.filter((l) => !l.startsWith("\\")).map((l) => `${l}\n`).join(""),
  );
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function ensureNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function stripEol(line: string | undefined): string {
  return (line ?? "").replace(/\r?\n$/, "");
}

/** Every row the diff shows, in order, with its line numbers on each side. */
export function diffRows(meta: FileDiffMetadata): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of meta.hunks) {
    const oldNum = (index: number) => hunk.deletionStart + index - hunk.deletionLineIndex;
    const newNum = (index: number) => hunk.additionStart + index - hunk.additionLineIndex;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let k = 0; k < block.lines; k++) {
          rows.push({
            type: "context",
            content: stripEol(meta.additionLines[block.additionLineIndex + k]),
            oldNum: oldNum(block.deletionLineIndex + k),
            newNum: newNum(block.additionLineIndex + k),
          });
        }
        continue;
      }
      for (let k = 0; k < block.deletions; k++) {
        rows.push({ type: "removed", content: stripEol(meta.deletionLines[block.deletionLineIndex + k]), oldNum: oldNum(block.deletionLineIndex + k) });
      }
      for (let k = 0; k < block.additions; k++) {
        rows.push({ type: "added", content: stripEol(meta.additionLines[block.additionLineIndex + k]), newNum: newNum(block.additionLineIndex + k) });
      }
    }
  }
  return rows;
}

// Pure unified-diff/patch parsing. Shared by the web diff viewer and the
// server-side file-change materializer — no React/DOM/Convex deps so it can run
// in a Convex mutation. The web-only presentation helper (getFileStatus) stays
// in packages/web/lib/patchParser.ts.

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface PatchLine {
  type: "context" | "addition" | "deletion";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  oldContent: string;
  newContent: string;
}

export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let currentHunk: PatchHunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/);

    if (hunkHeader) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      oldLineNum = parseInt(hunkHeader[1], 10);
      newLineNum = parseInt(hunkHeader[3], 10);
      currentHunk = {
        oldStart: oldLineNum,
        oldCount: parseInt(hunkHeader[2] || "1", 10),
        newStart: newLineNum,
        newCount: parseInt(hunkHeader[4] || "1", 10),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "addition",
        content: line.slice(1),
        newLineNumber: newLineNum++,
      });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "deletion",
        content: line.slice(1),
        oldLineNumber: oldLineNum++,
      });
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNumber: oldLineNum++,
        newLineNumber: newLineNum++,
      });
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const hunk of hunks) {
    for (const patchLine of hunk.lines) {
      if (patchLine.type === "context") {
        oldLines.push(patchLine.content);
        newLines.push(patchLine.content);
      } else if (patchLine.type === "deletion") {
        oldLines.push(patchLine.content);
      } else if (patchLine.type === "addition") {
        newLines.push(patchLine.content);
      }
    }
  }

  return {
    hunks,
    oldContent: oldLines.join("\n"),
    newContent: newLines.join("\n"),
  };
}

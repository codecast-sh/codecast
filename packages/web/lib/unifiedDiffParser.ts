import { parsePatch, type PatchHunk } from "./patchParser";

export interface UnifiedDiffSection {
  filePath: string;
  hunks: PatchHunk[];
  oldContent: string;
  newContent: string;
}

export function parseFileChangeSummary(summary: string): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[^:]+:\s*/, "").trim())
    .filter(Boolean);
}

function normalizeDiffPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed === "/dev/null") return "";
  return trimmed.replace(/^[ab]\//, "");
}

function resolveHeaderPath(lines: string[]): string {
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      return normalizeDiffPath(diffMatch[2]);
    }
    const plusMatch = line.match(/^\+\+\+\s+(.+)$/);
    if (plusMatch) {
      const filePath = normalizeDiffPath(plusMatch[1]);
      if (filePath) return filePath;
    }
    const minusMatch = line.match(/^---\s+(.+)$/);
    if (minusMatch) {
      const filePath = normalizeDiffPath(minusMatch[1]);
      if (filePath) return filePath;
    }
  }
  return "";
}

function splitUnifiedDiffSections(diffText: string): string[][] {
  const lines = diffText.split("\n");
  const sections: string[][] = [];
  let current: string[] = [];
  let currentHasHunk = false;

  const flush = () => {
    if (current.length > 0 && currentHasHunk) {
      sections.push(current);
    }
    current = [];
    currentHasHunk = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const startsDiffSection = line.startsWith("diff --git ");
    const startsHeaderSection = line.startsWith("--- ") && next.startsWith("+++ ");

    if ((startsDiffSection || startsHeaderSection) && current.length > 0 && currentHasHunk) {
      flush();
    }

    current.push(line);
    if (line.startsWith("@@")) {
      currentHasHunk = true;
    }
  }

  flush();
  return sections;
}

function parseSection(sectionLines: string[], fallbackPath?: string): UnifiedDiffSection | null {
  const filePath = resolveHeaderPath(sectionLines) || fallbackPath || "";
  if (!filePath) return null;

  const hunkStart = sectionLines.findIndex((line) => line.startsWith("@@"));
  const patchBody = (hunkStart >= 0 ? sectionLines.slice(hunkStart) : sectionLines).join("\n");
  const parsed = parsePatch(patchBody);

  if (!parsed.hunks.length && !parsed.oldContent && !parsed.newContent) {
    return null;
  }

  return {
    filePath,
    hunks: parsed.hunks,
    oldContent: parsed.oldContent,
    newContent: parsed.newContent,
  };
}

export function parseUnifiedDiffSections(diffText: string, fallbackPaths: string[] = []): UnifiedDiffSection[] {
  if (!diffText.trim()) return [];

  const hasHeaders = /^diff --git /m.test(diffText) || (/^--- /m.test(diffText) && /^\+\+\+ /m.test(diffText));
  if (hasHeaders) {
    return splitUnifiedDiffSections(diffText)
      .map((sectionLines, index) => parseSection(sectionLines, fallbackPaths[index]))
      .filter((section): section is UnifiedDiffSection => section !== null);
  }

  if (fallbackPaths.length === 1) {
    const parsed = parsePatch(diffText);
    if (parsed.hunks.length > 0 || parsed.oldContent || parsed.newContent) {
      return [{
        filePath: fallbackPaths[0],
        hunks: parsed.hunks,
        oldContent: parsed.oldContent,
        newContent: parsed.newContent,
      }];
    }
  }

  return [];
}

import { parsePatch, type PatchHunk } from "./patchParser";

export type ApplyPatchOperation = "Update" | "Add" | "Delete";

export interface ApplyPatchSection {
  filePath: string;
  operation: ApplyPatchOperation;
  hunks: PatchHunk[];
  oldContent: string;
  newContent: string;
}

export function getApplyPatchInput(toolInput: string): string {
  const raw = toolInput || "";
  if (!raw.trim()) return "";

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.input === "string" && record.input.trim()) {
        return record.input;
      }
      if (typeof record.patch === "string" && record.patch.trim()) {
        return record.patch;
      }
    }
  } catch {
    // Raw tool input may itself be patch text.
  }

  if (
    raw.includes("*** Begin Patch") ||
    raw.includes("*** Update File:") ||
    raw.includes("*** Add File:") ||
    raw.includes("*** Delete File:")
  ) {
    return raw;
  }

  return "";
}

function extractAddedContent(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

function extractDeletedContent(lines: string[]): string {
  return lines
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1))
    .join("\n");
}

function buildSyntheticHunk(
  operation: ApplyPatchOperation,
  lines: string[],
): PatchHunk | null {
  if (operation === "Add") {
    const additions = lines
      .filter((line) => line.startsWith("+"))
      .map((line, i) => ({
        type: "addition" as const,
        content: line.slice(1),
        newLineNumber: i + 1,
      }));
    if (additions.length === 0) return null;
    return {
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: additions.length,
      lines: additions,
    };
  }

  if (operation === "Delete") {
    const deletions = lines
      .filter((line) => line.startsWith("-"))
      .map((line, i) => ({
        type: "deletion" as const,
        content: line.slice(1),
        oldLineNumber: i + 1,
      }));
    if (deletions.length === 0) return null;
    return {
      oldStart: 1,
      oldCount: deletions.length,
      newStart: 1,
      newCount: 0,
      lines: deletions,
    };
  }

  return null;
}

export function parseApplyPatchSections(input: string): ApplyPatchSection[] {
  if (!input.trim()) return [];

  const lines = input.split("\n");
  const sections: Array<{ filePath: string; operation: ApplyPatchOperation; lines: string[] }> = [];
  let current: { filePath: string; operation: ApplyPatchOperation; lines: string[] } | null = null;

  for (const line of lines) {
    const fileMatch = line.match(/^\*\*\* (Update|Add|Delete) File:\s+(.+)$/);
    if (fileMatch) {
      if (current) sections.push(current);
      current = {
        operation: fileMatch[1] as ApplyPatchOperation,
        filePath: fileMatch[2].trim(),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File") continue;
    current.lines.push(line);
  }

  if (current) sections.push(current);

  return sections.flatMap((section) => {
    const patchBody = section.lines.join("\n").trim();
    const parsed = patchBody ? parsePatch(patchBody) : { hunks: [], oldContent: "", newContent: "" };
    if (parsed.hunks.length > 0) {
      return [{
        filePath: section.filePath,
        operation: section.operation,
        hunks: parsed.hunks,
        oldContent: parsed.oldContent,
        newContent: parsed.newContent,
      }];
    }

    const syntheticHunk = buildSyntheticHunk(section.operation, section.lines);
    const oldContent = section.operation === "Add" ? "" : extractDeletedContent(section.lines);
    const newContent = section.operation === "Delete" ? "" : extractAddedContent(section.lines);

    if (!oldContent && !newContent) {
      return [];
    }

    return [{
      filePath: section.filePath,
      operation: section.operation,
      hunks: syntheticHunk ? [syntheticHunk] : [],
      oldContent,
      newContent,
    }];
  });
}

// The ```cast-diff fence: its body is verbatim `git diff` output, drawn as
// one card per file (web InlineDiff, mobile CastDiff). Pure, so both apps
// parse a diff the same way.
import { parsePatch } from "@codecast/convex/convex/fileChanges/patchParser";
import type { PatchHunk } from "@codecast/convex/convex/fileChanges/patchParser";

export const DIFF_FENCE = "cast-diff";

export interface DiffFileSection {
  path: string;
  status: "added" | "deleted" | "modified";
  hunks: PatchHunk[];
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  // True when the patch carries the whole file in one hunk (git diff -U<huge>).
  // Only then can DiffView's oldStr/newStr mode collapse the unchanged lines
  // and open them again; a plain -U3 patch renders its hunks as-is.
  fullContext: boolean;
}

// Split a (possibly multi-file) `git diff` into per-file sections before
// parsing: parsePatch handles ONE file's patch, and a second file's
// `--- a/...`/`+++ b/...` header lines would otherwise leak into the previous
// file's last hunk as phantom deletion/addition lines.
export function parseCastDiff(raw: string): DiffFileSection[] {
  const segments: string[] = [];
  const headerRe = /^diff --git /;
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (headerRe.test(line) && current.length) {
      segments.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) segments.push(current.join("\n"));

  const files: DiffFileSection[] = [];
  for (const segment of segments) {
    if (!/^@@\s*-\d/m.test(segment)) continue;
    const oldHeader = segment.match(/^--- (?:a\/)?(.+)$/m)?.[1]?.trim();
    const newHeader = segment.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]?.trim();
    const gitHeader = segment.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1]?.trim();
    const status =
      oldHeader === "/dev/null" || /^new file mode /m.test(segment)
        ? "added"
        : newHeader === "/dev/null" || /^deleted file mode /m.test(segment)
          ? "deleted"
          : "modified";
    const path =
      (status === "deleted" ? oldHeader : newHeader && newHeader !== "/dev/null" ? newHeader : oldHeader) ??
      gitHeader;
    if (!path || path === "/dev/null") continue;

    const parsed = parsePatch(segment);
    if (!parsed.hunks.length) continue;
    let additions = 0;
    let deletions = 0;
    for (const hunk of parsed.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "addition") additions++;
        else if (line.type === "deletion") deletions++;
      }
    }
    files.push({
      path,
      status,
      hunks: parsed.hunks,
      oldContent: parsed.oldContent,
      newContent: parsed.newContent,
      additions,
      deletions,
      fullContext:
        status === "modified" && parsed.hunks.length === 1 && parsed.hunks[0].oldStart <= 1 && parsed.hunks[0].newStart <= 1,
    });
  }
  return files;
}

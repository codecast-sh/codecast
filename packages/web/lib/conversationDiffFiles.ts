import type { FileChange } from "./fileChangeExtractor";
import type { DiffFile } from "../components/FileDiffLayout";
import { computeCumulativeDiff } from "./cumulativeDiff";

export function computeCumulativeFiles(changes: FileChange[], upToIndex: number | null): DiffFile[] {
  const endIndex = upToIndex !== null ? upToIndex : changes.length - 1;
  if (endIndex < 0) return [];

  const relevantChanges = changes.slice(0, endIndex + 1).filter(c => c.changeType !== "commit");

  const lastIndexes = new Map(relevantChanges.map((change, index) => [change.filePath, index]));
  const newFiles = new Set<string>();
  const seenFiles = new Set<string>();
  for (const change of relevantChanges) {
    if (!seenFiles.has(change.filePath) && change.changeType === "write") newFiles.add(change.filePath);
    seenFiles.add(change.filePath);
  }
  const files: (DiffFile & { lastIndex: number })[] = [];
  for (const diff of computeCumulativeDiff(relevantChanges)) {
    const filePath = diff.filePath;
    const oldStr = diff.oldContent ?? "";
    const newStr = diff.newContent;
    const isNewFile = newFiles.has(filePath);
    if (oldStr === newStr && !isNewFile) continue;

    const patch = generateUnifiedPatch(filePath, oldStr, newStr);
    const patchLines = patch.split('\n');
    const additions = patchLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = patchLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;

    files.push({
      filename: filePath,
      status: isNewFile ? "added" : "modified",
      additions,
      deletions,
      changes: additions + deletions,
      patch,
      lastIndex: lastIndexes.get(filePath)!,
    });
  }

  files.sort((a, b) => b.lastIndex - a.lastIndex);

  return files.map(({ lastIndex, ...file }) => file);
}

function generateUnifiedPatch(filename: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  let patch = `--- a/${filename}\n+++ b/${filename}\n`;

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff: Array<{ type: "add" | "del" | "ctx"; line: string }> = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: "ctx", line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "add", line: newLines[j - 1] });
      j--;
    } else {
      diff.unshift({ type: "del", line: oldLines[i - 1] });
      i--;
    }
  }

  let hunkStart = -1;
  let hunkLines: string[] = [];
  let oldStart = 1, newStart = 1, oldCount = 0, newCount = 0;

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
      patch += hunkLines.join("\n") + "\n";
      hunkLines = [];
    }
  };

  let currentOldLine = 1, currentNewLine = 1;
  let lastChangeIdx = -1;

  diff.forEach((d, idx) => {
    const isChange = d.type !== "ctx";

    if (isChange) {
      if (hunkStart === -1 || idx > lastChangeIdx + 4) {
        flushHunk();
        const contextStart = Math.max(0, idx - 3);
        hunkStart = contextStart;
        oldStart = currentOldLine - (idx - contextStart);
        newStart = currentNewLine - (idx - contextStart);
        oldCount = 0;
        newCount = 0;

        for (let k = contextStart; k < idx; k++) {
          const prev = diff[k];
          if (prev.type === "ctx") {
            hunkLines.push(" " + prev.line);
            oldCount++;
            newCount++;
          }
        }
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx <= lastChangeIdx + 3) {
      if (d.type === "add") {
        hunkLines.push("+" + d.line);
        newCount++;
      } else if (d.type === "del") {
        hunkLines.push("-" + d.line);
        oldCount++;
      } else {
        hunkLines.push(" " + d.line);
        oldCount++;
        newCount++;
      }
    }

    if (d.type === "del") currentOldLine++;
    else if (d.type === "add") currentNewLine++;
    else { currentOldLine++; currentNewLine++; }
  });

  flushHunk();

  return patch;
}


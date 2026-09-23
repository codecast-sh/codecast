// A session's file changes folded into per-file diffs — PURE isomorphic data,
// shared by the web diff panel and `cast diff` so both draw the same tree from
// the same rows (messages.file_changes on the server, or a transcript scan).
//
// A change is one of: a string-replacing "edit" (old/new fragments), a whole
// file "write" (newContent is the file; oldContent, when present, is the file
// before it — a disk-observed rewrite), a "delete", or a "commit" (ignored
// here). Changes are applied in sequence order per file, and the result is the
// session's original text against its latest, plus a unified patch.

/** The minimal change shape the folding needs; the web's FileChange and the
 *  server's file_changes row both satisfy it. */
export interface CumulativeChange {
  filePath: string;
  changeType: 'write' | 'edit' | 'delete' | 'commit';
  oldContent?: string;
  newContent: string;
  sequenceIndex: number;
}

/** One file of the session tree, as the diff layouts render it. */
export interface DiffFile {
  filename: string;
  originalFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface CumulativeDiff {
  filePath: string;
  oldContent?: string;
  newContent: string;
  changeCount: number;
  /** The file's last change removed it. */
  deleted?: boolean;
}

/**
 * The file as it was before a run of string-replacing edits, recovered from
 * the text after them: undo each edit in reverse, first occurrence. Used when
 * a whole-file change arrives with the text it replaced, which already holds
 * the earlier edits, so the session's original is that text with them undone.
 */
function undoEdits(text: string, edits: Array<{ oldContent?: string; newContent: string }>): string {
  let result = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (!edit.newContent) continue;
    const idx = result.indexOf(edit.newContent);
    if (idx === -1) continue;
    result = result.slice(0, idx) + (edit.oldContent ?? '') + result.slice(idx + edit.newContent.length);
  }
  return result;
}

export function computeCumulativeDiff(changes: CumulativeChange[]): CumulativeDiff[] {
  if (changes.length === 0) {
    return [];
  }

  const fileGroups = new Map<string, CumulativeChange[]>();

  for (const change of changes) {
    if (change.changeType === 'commit') {
      continue;
    }
    const existing = fileGroups.get(change.filePath) || [];
    existing.push(change);
    fileGroups.set(change.filePath, existing);
  }

  const results: CumulativeDiff[] = [];

  for (const [filePath, fileChanges] of fileGroups.entries()) {
    fileChanges.sort((a, b) => a.sequenceIndex - b.sequenceIndex);

    let currentContent: string | undefined;
    let originalContent: string | undefined;
    let hasFullContent = false;
    let deleted = false;
    // String edits applied before any whole-file text was known.
    const partialEdits: Array<{ oldContent?: string; newContent: string }> = [];

    for (const change of fileChanges) {
      if (change.changeType === 'delete') {
        if (!hasFullContent && change.oldContent !== undefined) {
          originalContent = undoEdits(change.oldContent, partialEdits);
        }
        currentContent = '';
        hasFullContent = true;
        deleted = true;
      } else if (change.changeType === 'write') {
        deleted = false;
        if (!hasFullContent && change.oldContent !== undefined) {
          // A whole-file replacement that knows the text before it: that text
          // is the file after the earlier string edits, so the original is it
          // with those edits undone.
          originalContent = undoEdits(change.oldContent, partialEdits);
        }
        currentContent = change.newContent;
        hasFullContent = true;
      } else if (change.changeType === 'edit') {
        if (!hasFullContent) partialEdits.push({ oldContent: change.oldContent, newContent: change.newContent });
        if (hasFullContent && currentContent !== undefined && change.oldContent) {
          const idx = currentContent.indexOf(change.oldContent);
          if (idx !== -1) {
            currentContent =
              currentContent.slice(0, idx) +
              change.newContent +
              currentContent.slice(idx + change.oldContent.length);
          }
        } else if (!hasFullContent) {
          if (currentContent === undefined) {
            originalContent = change.oldContent;
            currentContent = change.newContent;
          } else if (change.oldContent) {
            const idx = currentContent.indexOf(change.oldContent);
            if (idx !== -1) {
              currentContent =
                currentContent.slice(0, idx) +
                change.newContent +
                currentContent.slice(idx + change.oldContent.length);
            } else {
              originalContent = (originalContent || '') + '\n' + change.oldContent;
              currentContent = currentContent + '\n' + change.newContent;
            }
          }
        }
      }
    }

    if (currentContent === undefined) continue;

    results.push({
      filePath,
      oldContent: originalContent,
      newContent: currentContent,
      changeCount: fileChanges.length,
      ...(deleted ? { deleted: true } : {}),
    });
  }

  return results;
}

export function getCumulativeDiffForFile(
  changes: CumulativeChange[],
  filePath: string
): CumulativeDiff | null {
  const fileChanges = changes.filter(c => c.filePath === filePath);
  if (fileChanges.length === 0) {
    return null;
  }

  const result = computeCumulativeDiff(fileChanges);
  return result[0] || null;
}

export function computeCumulativeFiles(changes: CumulativeChange[], upToIndex: number | null): DiffFile[] {
  const endIndex = upToIndex !== null ? upToIndex : changes.length - 1;
  if (endIndex < 0) return [];

  const relevantChanges = changes.slice(0, endIndex + 1).filter(c => c.changeType !== "commit");

  const lastIndexes = new Map(relevantChanges.map((change, index) => [change.filePath, index]));
  const newFiles = new Set<string>();
  const seenFiles = new Set<string>();
  for (const change of relevantChanges) {
    // A write that carries the text it replaced is a change to an existing file.
    if (!seenFiles.has(change.filePath) && change.changeType === "write" && change.oldContent === undefined) {
      newFiles.add(change.filePath);
    }
    seenFiles.add(change.filePath);
  }
  const files: (DiffFile & { lastIndex: number })[] = [];
  for (const diff of computeCumulativeDiff(relevantChanges)) {
    const filePath = diff.filePath;
    const oldStr = diff.oldContent ?? "";
    const newStr = diff.newContent;
    const isNewFile = newFiles.has(filePath);
    if (oldStr === newStr && !isNewFile && !diff.deleted) continue;

    const patch = generateUnifiedPatch(filePath, oldStr, newStr);
    const patchLines = patch.split('\n');
    const additions = patchLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = patchLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;

    files.push({
      filename: filePath,
      status: diff.deleted ? "deleted" : isNewFile ? "added" : "modified",
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

export function generateUnifiedPatch(filename: string, oldContent: string, newContent: string): string {
  // A file's final newline ends its last line rather than starting an empty one.
  const oldLines = oldContent ? oldContent.replace(/\n$/, "").split("\n") : [];
  const newLines = newContent ? newContent.replace(/\n$/, "").split("\n") : [];

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


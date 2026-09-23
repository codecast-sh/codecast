import type { FileChange } from '../store/diffViewerStore';

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

export function computeCumulativeDiff(changes: FileChange[]): CumulativeDiff[] {
  if (changes.length === 0) {
    return [];
  }

  const fileGroups = new Map<string, FileChange[]>();

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
        if (!hasFullContent && originalContent === undefined) {
          originalContent = change.oldContent !== undefined ? undoEdits(change.oldContent, partialEdits) : undefined;
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
  changes: FileChange[],
  filePath: string
): CumulativeDiff | null {
  const fileChanges = changes.filter(c => c.filePath === filePath);
  if (fileChanges.length === 0) {
    return null;
  }

  const result = computeCumulativeDiff(fileChanges);
  return result[0] || null;
}

import type { FileChange } from '../store/diffViewerStore';

export interface CumulativeDiff {
  filePath: string;
  oldContent?: string;
  newContent: string;
  changeCount: number;
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

    for (const change of fileChanges) {
      if (change.changeType === 'write') {
        currentContent = change.newContent;
        hasFullContent = true;
      } else if (change.changeType === 'edit') {
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

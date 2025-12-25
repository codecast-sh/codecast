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

    let currentContent = fileChanges[0].oldContent;

    for (const change of fileChanges) {
      if (change.changeType === 'write') {
        currentContent = change.newContent;
      } else {
        currentContent = change.newContent;
      }
    }

    const firstChange = fileChanges[0];
    const finalContent = currentContent!;

    results.push({
      filePath,
      oldContent: firstChange.oldContent,
      newContent: finalContent,
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

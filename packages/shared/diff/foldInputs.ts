// Which of a session's changes the fold (computeCumulativeDiff) actually
// reads. The fold reports a file's original text against its latest, so for
// each file only three groups of changes carry weight:
//
//   1. the leading changes up to and including the first whole-file one (a
//      write or delete): the string edits before it are undone to recover the
//      original, and the whole-file change supplies the text they ran on;
//   2. the LAST whole-file change at or before the selected position: it
//      resets the current text, so every change between it and group 1 is
//      overwritten and never read;
//   3. the string edits after that last whole-file change: they apply to it.
//
// Folding this subset gives the same result as folding everything, and it is
// what lets a session with hundreds of whole-file snapshots of one file render
// from two of them. The web fetches bodies for exactly these; the server
// bounds `cast diff`'s payload the same way.
export interface FoldInputRef {
  filePath: string;
  changeType: "write" | "edit" | "delete" | "commit";
}

export function selectFoldInputs<T extends FoldInputRef>(changes: T[], upToIndex: number | null): T[] {
  const end = Math.min(upToIndex !== null ? upToIndex : changes.length - 1, changes.length - 1);
  if (end < 0) return [];
  type FileState = { sawFull: boolean; lastFull: T | null; tail: T[] };
  const files = new Map<string, FileState>();
  const keep = new Set<T>();
  for (let i = 0; i <= end; i++) {
    const change = changes[i];
    if (change.changeType === "commit") continue;
    let state = files.get(change.filePath);
    if (!state) {
      state = { sawFull: false, lastFull: null, tail: [] };
      files.set(change.filePath, state);
    }
    const wholeFile = change.changeType !== "edit";
    if (!state.sawFull) {
      keep.add(change);
      if (wholeFile) state.sawFull = true;
    } else if (wholeFile) {
      state.lastFull = change;
      state.tail = [];
    } else {
      state.tail.push(change);
    }
  }
  for (const state of files.values()) {
    if (state.lastFull) keep.add(state.lastFull);
    for (const change of state.tail) keep.add(change);
  }
  return changes.filter((change, i) => i <= end && keep.has(change));
}

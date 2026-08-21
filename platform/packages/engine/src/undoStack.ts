export type UndoEntry = {
  label: string;
  undo: () => void;
  redo: () => void;
  ts: number;
};

// How the stack tells the user what happened. The engine ships no toast of its
// own: an app installs its notifier once at boot.
export type UndoNotifier = {
  notify: (message: string) => void;
  /** Show `label` with an inline "Undo" affordance wired to performUndo. */
  notifyWithUndo?: (label: string, undo: () => void) => void;
};

const MAX_STACK = 30;
const UNDO_EXPIRY_MS = 5 * 60_000;

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];
let notifier: UndoNotifier = { notify: () => {} };

export function setUndoNotifier(next: UndoNotifier): void {
  notifier = next;
}

export function pushUndo(entry: Omit<UndoEntry, "ts">) {
  undoStack.push({ ...entry, ts: Date.now() });
  if (undoStack.length > MAX_STACK) undoStack.shift();
  redoStack = [];
}

function pruneExpired(stack: UndoEntry[]): UndoEntry[] {
  const cutoff = Date.now() - UNDO_EXPIRY_MS;
  return stack.filter((e) => e.ts > cutoff);
}

export function performUndo(): boolean {
  undoStack = pruneExpired(undoStack);
  const entry = undoStack.pop();
  if (!entry) return false;
  entry.undo();
  redoStack.push(entry);
  notifier.notify(`Undid: ${entry.label}`);
  return true;
}

export function performRedo(): boolean {
  redoStack = pruneExpired(redoStack);
  const entry = redoStack.pop();
  if (!entry) return false;
  entry.redo();
  undoStack.push(entry);
  notifier.notify(`Redid: ${entry.label}`);
  return true;
}

export function showUndoToast(label: string) {
  if (notifier.notifyWithUndo) notifier.notifyWithUndo(label, () => performUndo());
  else notifier.notify(label);
}

export function canUndo(): boolean {
  undoStack = pruneExpired(undoStack);
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  redoStack = pruneExpired(redoStack);
  return redoStack.length > 0;
}

/** Test hook: the stacks live at module scope and would leak across tests. */
export function _resetUndoStacks(): void {
  undoStack = [];
  redoStack = [];
}

import { toast } from "sonner";

export type UndoEntry = {
  label: string;
  undo: () => void;
  redo: () => void;
  ts: number;
};

const MAX_STACK = 30;
const UNDO_EXPIRY_MS = 5 * 60_000;

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];

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
  toast(`Undid: ${entry.label}`);
  return true;
}

export function performRedo(): boolean {
  redoStack = pruneExpired(redoStack);
  const entry = redoStack.pop();
  if (!entry) return false;
  entry.redo();
  undoStack.push(entry);
  toast(`Redid: ${entry.label}`);
  return true;
}

export function showUndoToast(label: string) {
  toast(label, {
    action: { label: "Undo", onClick: () => performUndo() },
    duration: 5000,
  });
}

export function canUndo(): boolean {
  undoStack = pruneExpired(undoStack);
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  redoStack = pruneExpired(redoStack);
  return redoStack.length > 0;
}

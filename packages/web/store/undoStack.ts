// Codecast's binding of the @platform/engine undo stack. The mechanics (the
// stacks, the history, the guard, replay and redo) live in the engine; this
// module installs sonner as the notifier and preserves the import path.
//
// - A recorded entry's toast carries an Undo button for THAT entry
//   (undoEntry), never whatever happens to be newest.
// - Undo and redo announcements share one toast id, so a chain of undos
//   updates one toast instead of stacking them.
// - The "Undid" toast offers a quiet History action once there is more than
//   one thing in the history.
// - While the timeline card is open it narrates the steps, so the notifier
//   stays silent.
import { toast } from "sonner";
import { getUndoHistory, setUndoNotifier, undoEntry, type UndoEntry } from "@platform/engine";
import * as undoTimeline from "../lib/undoTimelineOpen";

export const UNDO_STATUS_TOAST_ID = "undo-status";

function stepMessage(kind: "undo" | "redo", steps: number, entry: UndoEntry): string {
  const verb = kind === "undo" ? "Undid" : "Redid";
  if (steps > 1) return `${verb} ${steps} changes`;
  const left = kind === "undo" ? entry.skipped?.length ?? 0 : 0;
  const partial = left > 0 ? ` (${left} changed since, left as ${left === 1 ? "it is" : "they are"})` : "";
  return `${verb}: ${entry.label}${partial}`;
}

setUndoNotifier({
  notify: (message) => {
    if (undoTimeline.isOpen()) return;
    toast(message, { id: UNDO_STATUS_TOAST_ID });
  },
  notifyWithUndo: (label, entryId) => {
    if (undoTimeline.isOpen()) return;
    toast(label, {
      action: { label: "Undo", onClick: () => undoEntry(entryId) },
      duration: 5000,
    });
  },
  onHistoryStep: (kind, steps, entry) => {
    if (undoTimeline.isOpen()) return;
    const more = kind === "undo" && getUndoHistory().items.length > 1;
    toast(stepMessage(kind, steps, entry), {
      id: UNDO_STATUS_TOAST_ID,
      ...(more ? { action: { label: "History", onClick: () => undoTimeline.open("interactive") } } : {}),
    });
  },
});

export {
  pushUndo,
  performUndo,
  performRedo,
  undoEntry,
  undoTo,
  redoTo,
  undoGroup,
  withoutUndo,
  showUndoToast,
  canUndo,
  canRedo,
  getUndoHistory,
  subscribeUndoHistory,
  getUndoKeyboardWindowMs,
  useUndoHistory,
  type UndoEntry,
  type UndoOutcome,
  type UndoHistoryItem,
  type UndoHistorySnapshot,
  type CellChange,
  type UndoSpec,
  type UndoWriter,
  type Invocation,
} from "@platform/engine";

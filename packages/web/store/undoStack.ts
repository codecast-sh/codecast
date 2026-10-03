// Codecast's binding of the @platform/engine undo stack. The mechanics (the
// stacks, the history, the guard, replay and redo) live in the engine; this
// module installs sonner as the notifier and preserves the import path.
//
// - A recorded entry's toast carries an Undo button for THAT entry
//   (undoEntry), never whatever happens to be newest. Each recorded toast has
//   its own id, and once its entry leaves the undo stack (stepped from the
//   toast, the keyboard or the timeline, a multi-step "Back to here"
//   included, or lost to a conflict) the toast comes down, so no Undo button
//   outlives its entry.
// - Undo and redo announcements share one toast id, so a chain of undos
//   updates one toast in place instead of stacking them. sonner merges an
//   update into the toast it replaces, so every announcement names its action
//   (or its absence) explicitly; a "Redid" must not keep the "Undid" History.
// - A partial step says how many rows it reached: "Undid: X (2 of 3; 1
//   changed since)". A conflict comes from the engine through notify:
//   "Can't undo X: changed since".
// - While the timeline tier is hidden, the "Undid" toast offers a quiet
//   History action once there is more history than the step it announces.
// - While the timeline card is open it narrates the steps, so the notifier
//   stays silent, and opening it takes down the status toast already showing.
//   A ⌘Z that stops at an entry whose undo widens access is the one notice
//   the card cannot narrate by moving its head, so it flashes that row.
import { toast } from "sonner";
import { getUndoHistory, setUndoNotifier, subscribeUndoHistory, undoEntry, undoRowCount, type UndoEntry, type UndoNotifier } from "@platform/engine";
import * as undoTimeline from "../lib/undoTimelineOpen";
import { countdownToast } from "../lib/persistentToast";
import { splitLabelNote } from "./undo/labels";

export const UNDO_STATUS_TOAST_ID = "undo-status";
/** The toast class that wears its action as a ghost button (components/ui/sonner.css). */
export const UNDO_QUIET_ACTION_CLASS = "cc-toast-quiet-action";

/** The id of the toast announcing a recorded entry. */
export function undoEntryToastId(entryId: string): string {
  return `undo-${entryId}`;
}

export function undoStepMessage(kind: "undo" | "redo", steps: number, entry: Pick<UndoEntry, "label" | "skipped" | "objects">): string {
  const verb = kind === "undo" ? "Undid" : "Redid";
  if (steps > 1) return `${verb} ${steps} changes`;
  const left = undoRowCount(entry.skipped);
  if (left === 0) return `${verb}: ${entry.label}`;
  const total = Math.max(undoRowCount(entry.objects), left);
  return `${verb}: ${entry.label} (${total - left} of ${total}; ${left} changed since)`;
}

/** Take down a toast if it is on screen (a no-op for an id that is not).
 *  sonner schedules the dismissal on a frame; without one (the bun store
 *  tests) no Toaster is mounted and there is nothing on screen to take down.
 *  Not gated on toast.getToasts(): a plain toast() never clears its id from
 *  sonner's dismissed set, so a reused id (the status toast) drops out of that
 *  list for good after its first dismissal while still showing on screen. */
function retireToast(id: string): void {
  if (typeof requestAnimationFrame !== "function") return;
  toast.dismiss(id);
}

/** Entries whose recorded toast may still be on screen. */
const liveEntryToasts = new Set<string>();

// Any history change can move several entries at once (undoTo walks the
// stack), so every live toast whose entry is no longer undoable comes down.
subscribeUndoHistory(() => {
  if (liveEntryToasts.size === 0) return;
  const undoable = new Set(getUndoHistory().undoOrder);
  for (const id of liveEntryToasts) {
    if (undoable.has(id)) continue;
    liveEntryToasts.delete(id);
    retireToast(undoEntryToastId(id));
  }
});

// The card opens in the toast corner and narrates from then on: the "Undid"
// toast that announced the step before the held peek opened, or a recorded
// entry's Undo toast, would sit on top of it. The card lists those entries
// with their own way back, so their toasts come down too.
undoTimeline.subscribe(() => {
  if (!undoTimeline.isOpen()) return;
  retireToast(UNDO_STATUS_TOAST_ID);
  for (const id of liveEntryToasts) retireToast(undoEntryToastId(id));
  liveEntryToasts.clear();
});

/** Codecast's notifier: sonner toasts, silent while the timeline is open. */
export const CODECAST_UNDO_NOTIFIER: UndoNotifier = {
  notify: (message) => {
    if (undoTimeline.isOpen()) return;
    toast(message, { id: UNDO_STATUS_TOAST_ID, description: undefined, action: undefined });
  },
  notifyWithUndo: (label, entryId) => {
    if (undoTimeline.isOpen()) return;
    liveEntryToasts.add(entryId);
    const forget = () => { liveEntryToasts.delete(entryId); };
    const [title, description] = splitLabelNote(label);
    toast(title, {
      id: undoEntryToastId(entryId),
      description,
      action: { label: "Undo", onClick: () => undoEntry(entryId) },
      ...countdownToast(5000),
      onAutoClose: forget,
      onDismiss: forget,
    });
  },
  onConfirmStop: (entry, message) => {
    if (undoTimeline.isOpen()) undoTimeline.flashRow(entry.id);
    else toast(message, { id: UNDO_STATUS_TOAST_ID, description: undefined, action: undefined });
  },
  onHistoryStep: (kind, steps, entry) => {
    if (undoTimeline.isOpen()) return;
    const more = kind === "undo"
      && undoTimeline.UNDO_HISTORY_TIER === "hidden"
      && getUndoHistory().items.length > steps;
    // The status toast is one id updated in place, so the note is always
    // passed, undefined included, or the last one's would stay under it.
    const [title, description] = splitLabelNote(undoStepMessage(kind, steps, entry));
    toast(title, {
      id: UNDO_STATUS_TOAST_ID,
      description,
      action: more ? { label: "History", onClick: () => undoTimeline.open("interactive") } : undefined,
      // Quiet: a way into the history, not the toast's answer (sonner.css).
      className: more ? UNDO_QUIET_ACTION_CLASS : undefined,
    });
  },
};
setUndoNotifier(CODECAST_UNDO_NOTIFIER);

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
  undoKeyboardSince,
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

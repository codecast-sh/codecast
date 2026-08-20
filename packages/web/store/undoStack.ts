// Codecast's binding of the @platform/engine undo stack: the stack mechanics
// (bounded depth, 5-minute expiry, redo clearing) live in the engine; this
// module installs sonner as the notifier so undo/redo keep announcing through
// the app's toast layer, and preserves the import path.
import { toast } from "sonner";
import { setUndoNotifier } from "@platform/engine";

setUndoNotifier({
  notify: (message) => toast(message),
  notifyWithUndo: (label, undo) =>
    toast(label, {
      action: { label: "Undo", onClick: () => undo() },
      duration: 5000,
    }),
});

export {
  pushUndo,
  performUndo,
  performRedo,
  showUndoToast,
  canUndo,
  canRedo,
  type UndoEntry,
} from "@platform/engine";

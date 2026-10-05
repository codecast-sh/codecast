// A window with no way to undo records no undo history while it is mounted.
// Undo lives with the dashboard (useUndoWalk's ⌘Z, the toast's Undo button,
// the timeline card), and the history is in memory per window
// (docs/architecture/undo-history.md S3). An auxiliary window (the palette,
// the agent dock, the call and people windows) mounts none of those, and some
// of them let clicks through everywhere but their own card, so an entry
// recorded there would strand: the gesture would look undoable, its toast
// could not be clicked, and ⌘Z in the main window would take back something
// else. Such a window mounts this instead. The guard test
// (hooks/__tests__/undoReachable.guard.test.ts) holds every Electron
// auxiliary window to it.
import { useLayoutEffect } from "react";
import { suspendUndoRecording } from "@platform/engine";

export function useUndoUnreachable(): void {
  useLayoutEffect(() => suspendUndoRecording(), []);
}

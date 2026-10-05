// A window records undo history only where it can reach it. Undo lives with
// the dashboard (useUndoWalk's ⌘Z, the toast's Undo button, the timeline
// card), and the history is in memory per window
// (docs/architecture/undo-history.md S3). An entry recorded where nothing
// can reach it strands: the gesture looks undoable, its toast cannot be
// clicked, and a later ⌘Z somewhere that does reach the history takes back
// something the person left behind.
//
// The rule holds by construction. The app's boot arms a gate
// (recordUndoOnlyWhereReachable) that keeps recording off, and every mounted
// reach (useUndoWalk, through useUndoReach) opens it while it is mounted. A
// page that picks its own frame, an auxiliary window, a shell nobody wired
// for undo: none records, with nothing to remember. useUndoUnreachable is the
// explicit hold for a window that mounts a reach it must not use (the people
// window renders dashboard parts); hooks/__tests__/undoReachable.guard.test.ts
// holds the auxiliary windows and shells to one or the other.
import { useLayoutEffect } from "react";
import { suspendUndoRecording } from "@platform/engine";

let armed = false;
let reaches = 0;
let gate: (() => void) | null = null;

/** Turn the gate on for this window: from now on, recording is on only while
 *  a reach is mounted. Called once at app boot; tests and other hosts that
 *  never call it record as before. */
export function recordUndoOnlyWhereReachable(): void {
  if (armed) return;
  armed = true;
  if (reaches === 0) gate = suspendUndoRecording();
}

/** A reach is mounted: recording is on until the returned release runs.
 *  Counted, and each release counts once. */
export function holdUndoReach(): () => void {
  reaches += 1;
  gate?.();
  gate = null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reaches -= 1;
    if (armed && reaches === 0) gate = suspendUndoRecording();
  };
}

export function useUndoReach(): void {
  useLayoutEffect(() => holdUndoReach(), []);
}

export function useUndoUnreachable(): void {
  useLayoutEffect(() => suspendUndoRecording(), []);
}

export function _resetUndoReachGate(): void {
  gate?.();
  gate = null;
  armed = false;
  reaches = 0;
}

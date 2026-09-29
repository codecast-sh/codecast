// THE STAGE OPENS ONLY ON AN EXPLICIT EXPAND (pl-756 F3).
//
// The full call stage used to open itself: video arriving, a media notice, a
// flag nothing reset. Now the row in the header is every call's small surface,
// and the stage is a door the person opens (Open the call beside the live
// card, or a stage collapse's opposite) and the call's end closes. One flag,
// read by the dock that draws the stage and written by whichever surface
// offers the door, outside React so a non React caller can open it too.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

export function getCallStageOpen(): boolean {
  return open;
}

export function subscribeCallStage(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function openCallStage(): void {
  if (open) return;
  open = true;
  emit();
}

// A door that was showing unread chat opens the stage with its thread open:
// the count is why the person clicked. The stage takes the request once, as
// it mounts, in this window.
let threadWanted = false;

export function requestCallThread(): void {
  threadWanted = true;
}

export function takeCallThreadRequest(): boolean {
  const wanted = threadWanted;
  threadWanted = false;
  return wanted;
}

export function closeCallStage(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useCallStageOpen(): boolean {
  return useSyncExternalStore(subscribeCallStage, getCallStageOpen, getCallStageOpen);
}

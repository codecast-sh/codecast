// On a phone-width window sonner lays toasts across the bottom edge, where the
// conversation's composer sits. A toast the person must read and answer (close
// advice's card on a Close or Kill receipt) rises above the composer instead
// of covering it. The composer is measured once, when such a toast goes up,
// never while typing.
import { useSyncExternalStore } from "react";

/** sonner's own phone breakpoint: below it, toasts use the mobile offset. */
const PHONE_MAX_PX = 600;
const GAP_PX = 8;

/** The bottom offset that clears a composer whose top edge is `composerTop`. */
export function composerLiftFor(composerTop: number, viewportHeight: number): number {
  return Math.max(0, Math.ceil(viewportHeight - composerTop + GAP_PX));
}

let lift: number | null = null;
/** How many toasts that need the room are up: the toaster stays lifted while any is. */
let holders = 0;
const listeners = new Set<() => void>();

function setLift(next: number | null): void {
  if (next === lift) return;
  lift = next;
  for (const fn of listeners) fn();
}

/** Measure the composer on screen (if any, on a phone-width window) and lift
 *  the toaster above it; with none, the toaster keeps its own place. Returns
 *  the toast's release: once every toast that lifted has released, the toaster
 *  goes back to its place. Releasing twice counts once. */
export function liftToasterAboveComposer(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  let next: number | null = null;
  if (window.innerWidth <= PHONE_MAX_PX) {
    const field = document.querySelector("[data-composer-field]");
    const box = field?.closest("[data-cc-composer-box]") ?? field;
    const top = box?.getBoundingClientRect().top;
    if (top !== undefined && top > 0) next = composerLiftFor(top, window.innerHeight);
  }
  holders += 1;
  setLift(next);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) setLift(null);
  };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The lift right now, in px, or null while the toaster keeps its own place. */
export const composerToasterLiftNow = (): number | null => lift;

/** The toaster's phone offset while a toast must clear the composer, else undefined. */
export function useComposerToasterLift(): { bottom: number } | undefined {
  const value = useSyncExternalStore(subscribe, composerToasterLiftNow, () => null);
  return value === null ? undefined : { bottom: value };
}

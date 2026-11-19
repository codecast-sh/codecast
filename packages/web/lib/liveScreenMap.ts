// A tiny store for a live artifact view's position mapping, read by its
// cursor layer alone (components/live/LiveCursors): a pan republishes it
// several times a second, and only the cursors redraw for it. One per open
// artifact (its page, a call's stage).
import type { ArtifactPosition } from "@codecast/shared/artifacts";
import type { ScreenPoint } from "../components/live/registry";

type ScreenMapFn = (pos: ArtifactPosition) => ScreenPoint | null;

export function createScreenMap() {
  let current: ScreenMapFn | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (map: ScreenMapFn) => {
      current = map;
      for (const fn of listeners) fn();
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type ScreenMap = ReturnType<typeof createScreenMap>;

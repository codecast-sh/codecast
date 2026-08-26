// React's view of the recorder engine (lib/calls/recorder).
//
// Two subscriptions, deliberately separate. The STATUS moves a handful of
// times a recording — start, a new sentence, stop — and wakes components. The
// LEVEL moves every animation frame and wakes nothing: it is written straight
// to a CSS variable on one element, the same shape as the walkie's meter and
// for the same reason.
import { useCallback, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import {
  bindRecorder,
  getRecorderLevel,
  getRecorderStatus,
  subscribeRecorder,
  subscribeRecorderLevel,
  type RecorderStatus,
} from "../lib/calls/recorder";
import { useMountEffect } from "./useMountEffect";

export function useRecorderStatus(): RecorderStatus {
  return useSyncExternalStore(subscribeRecorder, getRecorderStatus, getRecorderStatus);
}

/** Hands the engine its Convex client. Mounted once app-wide beside
 *  useCallSync — the record button and the pill live on different pages, and
 *  neither can be the thing that binds it. */
export function useRecorderSync(): void {
  const convex = useConvex();
  useMountEffect(() => {
    bindRecorder(convex);
  });
}

/** A ref callback that keeps `--level` on one element equal to what the
 *  microphone is hearing. Nothing re-renders; the browser animates from the
 *  variable. */
export function useRecorderLevelVar<T extends HTMLElement>(active: boolean) {
  return useCallback(
    (el: T | null) => {
      if (!el) return;
      el.style.setProperty("--level", "0");
      if (!active) return;
      const write = () => el.style.setProperty("--level", getRecorderLevel().toFixed(3));
      write();
      const off = subscribeRecorderLevel(write);
      return () => {
        off();
        el.style.setProperty("--level", "0");
      };
    },
    [active],
  );
}

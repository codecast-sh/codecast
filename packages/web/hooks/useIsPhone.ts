// Phone layout: the same 768px threshold DashboardLayout and
// useOpenLinkedSession use, as a live media query so a resize re-lays the page.
import { useState } from "react";
import { useMountEffect } from "./useMountEffect";

export const PHONE_MAX_WIDTH = 768;

/** Below Tailwind's `sm` (640px): the `max-sm:` layouts, as a media query,
 *  for code that must agree with them (the top bar drops its face row there). */
export const BELOW_SM = "(max-width: 639px)";

/** A CSS media query's answer, live: re-renders when it flips. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useMountEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return matches;
}

export function useIsPhone(): boolean {
  return useMediaQuery(`(max-width: ${PHONE_MAX_WIDTH - 1}px)`);
}

/** True while the viewport is at least `px` wide, as a live media query. The
 *  org page uses it to give a proposal's conversation its own column beside
 *  the change list only when both fit (org-staffing.md S18). */
export function useMinWidth(px: number): boolean {
  return useMediaQuery(`(min-width: ${px}px)`);
}

/** The main pointer is a finger: no hover, no Shift key, so anything that
 *  needs either offers a press and hold instead. */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

// Phone layout: the same 768px threshold DashboardLayout and
// useOpenLinkedSession use, as a live media query so a resize re-lays the page.
import { useMediaQuery } from "./useMediaQuery";

export const PHONE_MAX_WIDTH = 768;

/** Below Tailwind's `sm` (640px): the `max-sm:` layouts, as a media query,
 *  for code that must agree with them (the top bar drops its face row there). */
export const BELOW_SM = "(max-width: 639px)";

export function useIsPhone(): boolean {
  return useMediaQuery(`(max-width: ${PHONE_MAX_WIDTH - 1}px)`);
}

/** True while the viewport is at least `px` wide, as a live media query. The
 *  org page uses it to give a proposal's conversation its own column beside
 *  the change list only when both fit (org-staffing.md S18). */
export function useMinWidth(px: number): boolean {
  return useMediaQuery(`(min-width: ${px}px)`);
}


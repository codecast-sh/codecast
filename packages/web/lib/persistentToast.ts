import type { CSSProperties } from "react";
import type { ExternalToast } from "sonner";

/** Options for a toast that stays until the person closes it. No timer, and
 *  the close control shows all the time; a timed toast reveals it on hover
 *  (components/ui/sonner.css). Spread these at the call site:
 *  `toast.error(msg, { ...persistentToast })`. Kept apart from the Toaster so
 *  a hook can use it without pulling the component into its import graph. */
export const persistentToast = {
  duration: Infinity,
  closeButton: true,
  className: "cc-toast-sticky",
} as const satisfies ExternalToast;

/** Options for a timed toast whose action only works while it shows (Undo).
 *  A hairline along its foot drains over its life and holds while the pointer
 *  rests on the stack, as sonner's timer does (components/ui/sonner.css). */
export function countdownToast(ms: number) {
  return {
    duration: ms,
    className: "cc-toast-countdown",
    style: { "--toast-life": `${ms}ms` } as CSSProperties,
  } as const satisfies ExternalToast;
}

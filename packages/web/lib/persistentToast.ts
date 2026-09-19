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

import { usePathname, useSearchParams } from "next/navigation";
import NProgress from "nprogress";
import { useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { shouldStartNavigationProgress } from "../lib/navigationProgress";

NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 });

// A bar that starts on a click it cannot finish is worse than no bar. The
// completion signal is a router transition, so anything that navigates by
// another route — the vault opening a note, an object pill opening its
// reveal band, any handler that calls preventDefault and moves the view
// through the store — must never start it.
const STUCK_BAR_MS = 4000;

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const failsafe = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = () => {
    if (failsafe.current) {
      clearTimeout(failsafe.current);
      failsafe.current = null;
    }
    NProgress.done();
  };

  useWatchEffect(() => {
    finish();
    return finish;
  }, [pathname, searchParams]);

  useEventListener(
    "click",
    (e: MouseEvent) => {
      if (!shouldStartNavigationProgress(e, window.location.href)) return;
      NProgress.start();
      // Last line of defence: some destinations render without changing the
      // pathname this pane reports (the tab shell rewrites its stored path
      // rather than pushing a route). Rather than reason about every such
      // case, guarantee the bar ends.
      if (failsafe.current) clearTimeout(failsafe.current);
      failsafe.current = setTimeout(finish, STUCK_BAR_MS);
    },
    document,
  );

  return null;
}

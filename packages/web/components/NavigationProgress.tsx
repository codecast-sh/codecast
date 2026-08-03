import { usePathname, useSearchParams } from "next/navigation";
import NProgress from "nprogress";
import { useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";

NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 });

// A bar that starts on a click it cannot finish is worse than no bar. The
// completion signal is a router transition, so anything that navigates by
// another route — the vault opening a note, any handler that calls
// preventDefault and moves the view through the store — must never start it.
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
      // NOT a defaultPrevented check: React Router's Link prevents default too,
      // and those DO complete normally. Suppressing every prevented click would
      // remove the bar from the one case it works for. An anchor that navigates
      // by some other means says so with data-no-progress instead (below).
      //
      // A modifier click opens a new tab or window; this view isn't going
      // anywhere.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download") || anchor.dataset.noProgress !== undefined) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;

      try {
        const targetUrl = new URL(href, window.location.href);
        // Only a same-origin http(s) link routes in-app. Custom schemes — the
        // vault's `wiki://` payloads among them — are data for a handler, not
        // destinations the router will ever navigate to.
        if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") return;
        if (targetUrl.origin !== window.location.origin) return;

        const currentUrl = new URL(window.location.href);
        if (targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search) return;

        NProgress.start();
        // Last line of defence: some destinations render without changing the
        // pathname this pane reports (the tab shell rewrites its stored path
        // rather than pushing a route). Rather than reason about every such
        // case, guarantee the bar ends.
        if (failsafe.current) clearTimeout(failsafe.current);
        failsafe.current = setTimeout(finish, STUCK_BAR_MS);
      } catch {}
    },
    document,
  );

  return null;
}

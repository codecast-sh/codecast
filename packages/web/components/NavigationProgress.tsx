import { usePathname, useSearchParams } from "next/navigation";
import NProgress from "nprogress";
import { useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";

NProgress.configure({ showSpinner: false, trickleSpeed: 200, minimum: 0.1 });

// A bar that starts on a click it cannot finish is worse than no bar. The
// completion signal is a router transition, so anything that navigates by
// another route — the vault opening a note, an object pill opening its
// reveal band, any handler that calls preventDefault and moves the view
// through the store — must never start it.
const STUCK_BAR_MS = 4000;

/** Whether this click should start the top progress bar. Extracted so the
 *  opt-outs stay testable: `data-no-progress` is how a same-origin <a> says
 *  the click will not produce a router transition. */
export function shouldStartNavigationProgress(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button" | "target">,
  locationHref: string,
): boolean {
  // NOT a defaultPrevented check: React Router's Link prevents default too,
  // and those DO complete normally. Suppressing every prevented click would
  // remove the bar from the one case it works for. An anchor that navigates
  // by some other means says so with data-no-progress instead.
  //
  // A modifier click opens a new tab or window; this view isn't going
  // anywhere.
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return false;

  const target = e.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a");
  if (!anchor) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download") || anchor.dataset.noProgress !== undefined) return false;

  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return false;

  try {
    const targetUrl = new URL(href, locationHref);
    // Only a same-origin http(s) link routes in-app. Custom schemes — the
    // vault's `wiki://` payloads among them — are data for a handler, not
    // destinations the router will ever navigate to.
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") return false;
    const currentUrl = new URL(locationHref);
    if (targetUrl.origin !== currentUrl.origin) return false;
    if (targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search) return false;
    return true;
  } catch {
    return false;
  }
}

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

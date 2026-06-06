import { useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  buildDesktopDeepLink,
  isDesktop,
  shouldAttemptHandoff,
  type HandoffContext,
} from "../lib/desktop";
import { useTrackedStore } from "../store/inboxStore";

// A clicked/typed link reads as "navigate"; reload / back-forward should be
// left in the browser. Unknown (no entry) is treated as fresh.
function isFreshNavigation(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav ? nav.type === "navigate" : true;
  } catch {
    return true;
  }
}

/**
 * When a codecast.sh page is opened in a browser and the user owns the desktop
 * app, hand the page off to the app (codecast://open/<path>) and show a small
 * "Opening in Codecast…" toast with a remembered "stay in browser" escape hatch.
 * Pure gating lives in `shouldAttemptHandoff`; this just collects the context.
 */
export function OpenInDesktopHandoff() {
  const s = useTrackedStore([
    (s) => s.clientStateInitialized,
    (s) => s.clientState.dismissed?.has_used_desktop,
    (s) => s.clientState.dismissed?.prefer_browser_links,
  ]);

  const [visible, setVisible] = useState(false);
  const attemptedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openInDesktop = () => {
    window.location.href = buildDesktopDeepLink(
      window.location.pathname + window.location.search,
    );
  };

  const stayInBrowser = () => {
    s.updateClientDismissed("prefer_browser_links", true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(false);
  };

  useWatchEffect(() => {
    if (attemptedRef.current || typeof window === "undefined") return;

    const ctx: HandoffContext = {
      isDesktop: isDesktop(),
      initialized: s.clientStateInitialized,
      hasUsedDesktop: s.clientState.dismissed?.has_used_desktop ?? false,
      preferBrowser: s.clientState.dismissed?.prefer_browser_links ?? false,
      isTopWindow: window.top === window.self,
      host: window.location.host,
      freshNavigation: isFreshNavigation(),
      path: window.location.pathname,
      search: window.location.search,
    };
    // TEMP DIAGNOSTIC
    console.log("[handoff]", JSON.stringify(ctx), "=>", shouldAttemptHandoff(ctx));
    if (!shouldAttemptHandoff(ctx)) return;

    attemptedRef.current = true;
    openInDesktop();
    setVisible(true);
    hideTimerRef.current = setTimeout(() => setVisible(false), 7000);
  }, [
    s.clientStateInitialized,
    s.clientState.dismissed?.has_used_desktop,
    s.clientState.dismissed?.prefer_browser_links,
  ]);

  if (!visible) return null;

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-sol-cyan/30 bg-sol-bg-alt px-4 py-2.5 shadow-lg shadow-sol-cyan/10 backdrop-blur-md">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-cyan/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-cyan" />
        </span>
        <Monitor className="h-4 w-4 flex-shrink-0 text-sol-cyan" />
        <div className="flex flex-col leading-tight">
          <span className="text-xs text-sol-text">Opening in Codecast…</span>
          <button
            onClick={stayInBrowser}
            className="text-left text-[11px] text-sol-text-dim transition-colors hover:text-sol-text"
          >
            Stay in browser instead
          </button>
        </div>
        <button
          onClick={openInDesktop}
          className="ml-1 rounded-md bg-sol-cyan px-3 py-1 text-[11px] font-medium text-sol-bg transition-opacity hover:opacity-90"
        >
          Open
        </button>
        <button
          onClick={stayInBrowser}
          aria-label="Stay in browser"
          className="text-sol-text-dim transition-colors hover:text-sol-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

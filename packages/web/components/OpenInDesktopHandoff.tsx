import { useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  buildDesktopDeepLink,
  isDesktop,
  isForegroundTab,
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
 * When a codecast.sh page is opened in a foreground browser tab and the user
 * owns the desktop app, hand the page off to the app (codecast://open/<path>)
 * — the Figma/Slack flavor: open immediately, then show an "Opened in Codecast
 * desktop" screen with an escape hatch (use the browser for this page, or a
 * sticky "always open in browser"). Pure gating lives in `shouldAttemptHandoff`;
 * this collects the context, re-checks on focus for background-opened tabs, and
 * renders the screen.
 */
export function OpenInDesktopHandoff() {
  const s = useTrackedStore([
    (s) => s.clientStateInitialized,
    (s) => s.clientState.dismissed?.has_used_desktop,
    (s) => s.clientState.dismissed?.prefer_browser_links,
  ]);

  const [visible, setVisible] = useState(false);
  const attemptedRef = useRef(false);

  const openInDesktop = () => {
    window.location.href = buildDesktopDeepLink(
      window.location.pathname + window.location.search,
    );
  };

  // Use the browser for THIS page only — does not change the sticky preference,
  // so the next fresh visit still hands off to the app.
  const stayHereOnce = () => setVisible(false);

  // Permanent opt-out: never hand off again (synced per-user). One click both
  // persists and dismisses, so it's never a two-step choice.
  const alwaysBrowser = () => {
    s.updateClientDismissed("prefer_browser_links", true);
    setVisible(false);
  };

  useWatchEffect(() => {
    if (attemptedRef.current || typeof window === "undefined") return;

    const buildCtx = (): HandoffContext => ({
      isDesktop: isDesktop(),
      initialized: s.clientStateInitialized,
      hasUsedDesktop: s.clientState.dismissed?.has_used_desktop ?? false,
      preferBrowser: s.clientState.dismissed?.prefer_browser_links ?? false,
      isTopWindow: window.top === window.self,
      foreground: isForegroundTab(),
      host: window.location.host,
      freshNavigation: isFreshNavigation(),
      path: window.location.pathname,
      search: window.location.search,
    });

    const tryHandoff = (): boolean => {
      if (attemptedRef.current) return true;
      if (!shouldAttemptHandoff(buildCtx())) return false;
      attemptedRef.current = true;
      openInDesktop();
      setVisible(true);
      return true;
    };

    if (tryHandoff()) return;

    // Not eligible right now. If the only blocker is that the tab isn't in the
    // foreground (cmd-clicked into the background, or not yet focused), wait and
    // retry the moment the user actually looks at it. Any other blocker
    // (preferBrowser, ineligible path, not our host, …) is permanent — bail.
    if (!shouldAttemptHandoff({ ...buildCtx(), foreground: true })) return;

    const onActive = () => {
      if (tryHandoff()) teardown();
    };
    const teardown = () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return teardown;
  }, [
    s.clientStateInitialized,
    s.clientState.dismissed?.has_used_desktop,
    s.clientState.dismissed?.prefer_browser_links,
  ]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-sol-bg/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative mx-4 w-full max-w-sm rounded-xl border border-sol-cyan/30 bg-sol-bg-alt p-6 shadow-2xl shadow-sol-cyan/10 animate-in zoom-in-95 duration-200">
        <button
          onClick={stayHereOnce}
          aria-label="Dismiss"
          className="absolute right-3 top-3 text-sol-text-dim transition-colors hover:text-sol-text"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg bg-sol-cyan/10 text-sol-cyan">
            <Monitor className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-medium text-sol-text">Opened in Codecast desktop</div>
            <div className="text-xs text-sol-text-dim">This page was sent to the app.</div>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={stayHereOnce}
            className="w-full rounded-md bg-sol-cyan px-3 py-2 text-xs font-medium text-sol-bg transition-opacity hover:opacity-90"
          >
            Open in browser
          </button>
          <button
            onClick={openInDesktop}
            className="w-full rounded-md border border-sol-border px-3 py-2 text-xs text-sol-text-dim transition-colors hover:border-sol-cyan/40 hover:text-sol-text"
          >
            Didn’t open? Reopen desktop app
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer select-none items-center gap-2 text-[11px] text-sol-text-dim">
          <input type="checkbox" onChange={alwaysBrowser} className="accent-sol-cyan" />
          Always open Codecast links in browser
        </label>
      </div>
    </div>
  );
}

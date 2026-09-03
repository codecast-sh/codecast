import { useRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  armForegroundHandoff,
  isDesktop,
  isForegroundTab,
  isFreshNavigation,
  openDesktop,
  readSkippedUrl,
  shouldAttemptHandoff,
  showHandoffScreen,
  takePendingPreferBrowser,
  writeHandoffMirror,
  type HandoffContext,
} from "../lib/desktop";
import { useTrackedStore } from "../store/inboxStore";

/**
 * When a codecast.sh page is opened in a foreground browser tab and the user
 * owns the desktop app, hand the page off to the app (codecast://open/<path>)
 * — the Figma/Slack flavor: open immediately, then show the static "Opened in
 * Codecast desktop" screen from index.html (close this tab, or use the browser
 * for this page, or a sticky "always open in browser"). Pure gating lives in
 * `shouldAttemptHandoff`; this collects the context and re-checks on focus for
 * background-opened tabs.
 *
 * Most handoffs never get here: the same gate runs inlined in index.html's
 * <head> against a localStorage mirror of the two synced preferences, firing the
 * deep link before any app chunk loads (lib/desktopHandoff.ts). This component
 * covers the one case that path can't know — a first visit before the mirror
 * exists — and it is what keeps the mirror honest.
 */
export function OpenInDesktopHandoff() {
  const s = useTrackedStore([
    (s) => s.clientStateInitialized,
    (s) => s.clientState.dismissed?.has_used_desktop,
    (s) => s.clientState.dismissed?.prefer_browser_links,
  ]);

  const attemptedRef = useRef(false);
  const hideScreenRef = useRef<(() => void) | null>(null);

  // The pre-boot screen can take the permanent opt-out before the app exists, so
  // it parks the choice for whoever boots next; only the store can reach the
  // server with it.
  useMountEffect(() => {
    if (takePendingPreferBrowser()) s.updateClientDismissed("prefer_browser_links", true);
    return () => hideScreenRef.current?.();
  });

  // Keep the pre-boot mirror in step with the synced preferences. This is the
  // only writer: the mirror stands for "a browser on this device should hand
  // off", so the desktop app itself must never write one (its renderer runs the
  // same inlined gate).
  useWatchEffect(() => {
    if (isDesktop() || !s.clientStateInitialized) return;
    const hasUsedDesktop = s.clientState.dismissed?.has_used_desktop ?? false;
    const preferBrowser = s.clientState.dismissed?.prefer_browser_links ?? false;
    writeHandoffMirror(hasUsedDesktop && !preferBrowser);
  }, [
    s.clientStateInitialized,
    s.clientState.dismissed?.has_used_desktop,
    s.clientState.dismissed?.prefer_browser_links,
  ]);

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
      skippedUrl: readSkippedUrl(),
    });

    const tryHandoff = (): boolean => {
      if (attemptedRef.current) return true;
      if (!shouldAttemptHandoff(buildCtx())) return false;
      attemptedRef.current = true;
      // `auto` distinguishes the page redirecting itself from the user clicking
      // "Reopen desktop app" — the desktop only trusts the latter
      // unconditionally (see shouldApplyAutoDeepLink).
      openDesktop({ auto: true });
      // Permanent opt-out, synced per-user: one click both persists and
      // dismisses, so it's never a two-step choice.
      hideScreenRef.current = showHandoffScreen({
        booted: true,
        onAlways: () => s.updateClientDismissed("prefer_browser_links", true),
      });
      return true;
    };

    if (tryHandoff()) return;

    // Not eligible right now. If the only blocker is that the tab isn't in the
    // foreground (cmd-clicked into the background, or not yet focused), wait and
    // retry the moment the user actually looks at it. Any other blocker
    // (preferBrowser, ineligible path, not our host, …) is permanent — bail.
    if (!shouldAttemptHandoff({ ...buildCtx(), foreground: true })) return;
    return armForegroundHandoff(tryHandoff);
  }, [
    s.clientStateInitialized,
    s.clientState.dismissed?.has_used_desktop,
    s.clientState.dismissed?.prefer_browser_links,
  ]);

  return null;
}

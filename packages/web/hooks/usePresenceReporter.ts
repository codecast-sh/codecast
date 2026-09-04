import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { getIdleMs, installDesktopInputTracker, isElectron } from "../lib/desktop";

import { useWatchEffect } from "./useWatchEffect";
// Tell the server a human is at this desktop surface (pushRouter.reportPresence).
// The server uses it to keep mobile pushes quiet while you're actually here, so
// the fidelity bar is low: a coarse heartbeat with input recency. Electron
// reports OS-wide idle (correct even while Codecast is unfocused); a browser
// tab reports only in-page input and stops entirely while hidden, letting
// presence go stale on its own — same as when the machine sleeps.
const HEARTBEAT_MS = 30_000;
const MIN_GAP_MS = 10_000;

export function usePresenceReporter() {
  const report = useMutation(api.pushRouter.reportPresence);
  // Providers mounts this on every page, marketing included — only signed-in
  // users have presence worth reporting (the server no-ops anyway, but don't
  // send anonymous write traffic at all).
  const { isAuthenticated } = useConvexAuth();

  useWatchEffect(() => {
    if (typeof window === "undefined" || !isAuthenticated) return;
    installDesktopInputTracker();

    // Focusing the app is activity the in-page input tracker can't see — the
    // click that focused the window can land on the dock or another screen.
    let activityFloor = document.hasFocus() ? Date.now() : 0;
    let lastSent = 0;
    let stopped = false;

    const send = async () => {
      if (stopped) return;
      if (!isElectron() && document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastSent < MIN_GAP_MS) return;
      lastSent = now;
      const idleMs = await getIdleMs(activityFloor);
      report({
        focused: document.hasFocus(),
        idle_ms: Math.min(Math.round(idleMs), Number.MAX_SAFE_INTEGER),
      }).catch(() => {});
    };

    const onFocus = () => {
      activityFloor = Date.now();
      void send();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(() => void send(), HEARTBEAT_MS);
    void send();

    return () => {
      stopped = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [report, isAuthenticated]);
}

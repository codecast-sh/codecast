import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { initAnalytics, setupErrorToasts } from "../lib/analytics";
import { armChunkReloadGuardReset } from "../components/ErrorBoundary";
import { installIdleAnimationPause, isDesktop } from "../lib/desktop";
import { hasStoredAuthToken } from "../lib/localAuth";
import { App } from "./App";
import "../store/inboxStore";
import "../app/globals.css";

setupErrorToasts();
// Stop compositing infinite animations while the desktop window is backgrounded.
installIdleAnimationPause();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Defer non-critical work until after first paint.
const idle: (cb: () => void) => void =
  (typeof window !== "undefined" && (window as any).requestIdleCallback) ||
  ((cb) => setTimeout(cb, 1));

idle(() => initAnalytics());

// Install the offline app shell (service worker precache) once the app is
// interactive. First visit installs it in the background; every later boot —
// including fully offline desktop launches — serves the shell from it.
// Only for app users (signed in, or the desktop shell): the precache pulls the
// whole bundle, which anonymous share-link visitors shouldn't pay for.
// No-op in dev (vite-plugin-pwa only emits the worker on build).
idle(() => {
  if (!hasStoredAuthToken() && !isDesktop()) return;
  import("virtual:pwa-register")
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {});
});

// If this load stays up (no immediate chunk re-crash), clear the auto-reload
// guard so a future stale-chunk crash in this tab can recover on its own.
armChunkReloadGuardReset();

// Warm the cache for the most-visited app routes so the first navigation
// (or direct landing) doesn't pay a chunk-fetch waterfall. Skip for visitors
// who almost certainly won't enter the app (no auth, on a marketing path).
idle(() => {
  const path = window.location.pathname;
  const onAppPath = !/^\/($|about|features|documentation|changelog|privacy|security|support|terms|login|signup|forgot-password|reset-password)(\/|$)/.test(path);
  const hasAuth = (() => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.includes("convex") && k.toLowerCase().includes("auth")) return true;
      }
    } catch {}
    return false;
  })();
  if (!onAppPath && !hasAuth) return;
  void import("@/app/inbox/page");
  void import("@/app/team/activity/page");
});

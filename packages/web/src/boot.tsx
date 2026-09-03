import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { initAnalytics, reportRecoverableRenderError, setupErrorToasts } from "../lib/analytics";
import { armChunkReloadGuardReset } from "../lib/chunkReloadGuard";
import { installIdleAnimationPause, isDesktop } from "../lib/desktop";
import { hasStoredAuthToken } from "../lib/localAuth";
import { createReloadWhenHidden } from "../lib/reloadWhenHidden";
import { App } from "./App";
import "../store/inboxStore";

// Everything here used to live in main.tsx, which is now a stub that loads this
// module dynamically — see main.tsx for why (the desktop hand-off must be able
// to skip the app entirely). Nothing else about the boot sequence changed.

// Which build a driver is attached to (`cast app doctor`). Stamped by the
// vite define in vite.config.ts; without it an agent cannot tell a stale
// bundle from the tree it just edited.
(window as any).__CODECAST_BUILD = __CODECAST_BUILD__;

setupErrorToasts();
// Stop compositing infinite animations while the desktop window is backgrounded.
installIdleAnimationPause();

// StrictMode is a development aid: in dev it renders every component body
// twice and double-runs effects, which measured at ~40% of all render time on
// local. It stays on for browsers (where people debug), and off inside the
// desktop shell, where local is a daily driver, not a debugger — the desktop
// pointed at local should feel like the product. Prod builds strip the
// double-invoke anyway, so this changes nothing there.
// Dev-only: React 19 captures an Error() per created element for "owner
// stacks" (jsxDEV), until a 10k-per-render cap after which it reuses a shared
// sentinel. V8's stack capture costs O(live stack depth) whatever
// Error.stackTraceLimit says, and React's render stack is deep: measured ~60ms
// of pure element creation per ConversationView pass (2.9s of a 3s session
// switch on local). Pinning the counter at the cap makes every element take
// React's own cheap path. Only dev warnings lose the owner stack; set
// localStorage cc_owner_stacks=1 when you need them.
if (import.meta.env.DEV && localStorage.getItem("cc_owner_stacks") !== "1") {
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (internals && "recentlyCreatedOwnerStacks" in internals) {
    Object.defineProperty(internals, "recentlyCreatedOwnerStacks", { get: () => 1e4, set() {}, configurable: true });
  }
}

const app = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
ReactDOM.createRoot(document.getElementById("root")!, {
  // A render that threw and that React re-ran successfully. React's default
  // handler rethrows a wrapper whose message is only the error code, with the
  // real failure hidden in `cause` — that is where "Uncaught: Minified React
  // error #520" came from. Take the callback so the report names the throw.
  onRecoverableError: reportRecoverableRenderError,
}).render(
  isDesktop() ? app : <React.StrictMode>{app}</React.StrictMode>
);

// Defer non-critical work until after first paint. The timeout is load-bearing:
// Chrome starves idle callbacks entirely in hidden/occluded windows, and the
// desktop app often boots minimized — without it, everything deferred here
// (analytics, the offline-shell registration, route warmup) never runs until
// the window is first focused.
const idle: (cb: () => void) => void =
  typeof window !== "undefined" && (window as any).requestIdleCallback
    ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 15_000 })
    : (cb) => setTimeout(cb, 1);

idle(() => void initAnalytics().catch(() => {}));

// Install the offline app shell (service worker precache) once the app is
// interactive. First visit installs it in the background; every later boot —
// including fully offline desktop launches — serves the shell from it.
// Only for app users (signed in, or the desktop shell): the precache pulls the
// whole bundle, which anonymous share-link visitors shouldn't pay for.
// No-op in dev (vite-plugin-pwa only emits the worker on build).
idle(() => {
  if (!hasStoredAuthToken() && !isDesktop()) return;
  import("virtual:pwa-register")
    .then(({ registerSW }) =>
      registerSW({
        immediate: true,
        // Browsers only look for a new sw.js on navigation (or every 24h),
        // and the desktop window stays open for days without navigating — a
        // stale shell would pin users to old bundles across deploys. Poll so
        // the new worker (skipWaiting+clientsClaim) takes over unprompted;
        // any stale lazy-chunk fetch after the swap is healed by the chunk
        // reload guard in ErrorBoundary. Fifteen minutes: a deploy reaches a
        // window that never navigates within a quarter hour plus its next
        // hide, instead of an hour plus.
        onRegisteredSW(_url, reg) {
          if (!reg) return;
          setInterval(() => { reg.update().catch(() => {}); }, 15 * 60 * 1000);
        },
        // Without this, autoUpdate hard-reloads every open window the moment
        // the new worker activates — visibly blinking whichever window the
        // user is looking at (and resetting the palette popup mid-compose).
        // Defer each window's reload until it is hidden; see the helper.
        onNeedReload: createReloadWhenHidden(),
      })
    )
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
  // The decision queue opens on every Questions-card click — it must open
  // instantly, so it warms with the hot set even in dev.
  void import("@/app/questions/page");
  // Then every other shell route (prod only — in dev this would make Vite
  // transform the whole app at boot). Wait until the window is hidden or has
  // been open for a minute so startup and the first interaction stay clear.
  // Warming still precedes the service worker's first 15-minute update.
  if (import.meta.env.PROD) {
    void import("../lib/tabLazyPages")
      .then((module) => module.scheduleTabRouteWarmup())
      .catch(() => {});
  }
});

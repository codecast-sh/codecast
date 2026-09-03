/**
 * The browser → desktop-app hand-off contract, in one file with ZERO imports.
 *
 * Two very different callers share this code, which is why it lives apart from
 * lib/desktop.ts:
 *
 *  1. `runPreBootHandoff` is transformed to a standalone IIFE and inlined into
 *     index.html's <head> (plugins/handoffBoot.ts). It runs while the HTML is
 *     still parsing — before one byte of app JavaScript is fetched — so a page
 *     that is only going to be handed to the desktop app never pays for a
 *     React boot, a Convex socket, or an IndexedDB hydration it is about to
 *     abandon. Because it is inlined rather than bundled with the app, this
 *     file must not import anything.
 *  2. The React component `OpenInDesktopHandoff` runs the same gate after boot,
 *     covering what the pre-boot path cannot know: a first visit before the
 *     localStorage mirror exists. It shows the same static screen
 *     (`showHandoffScreen`) — there is one screen, not a React twin.
 */

// ---------------------------------------------------------------------------
// Deep links (codecast:// custom protocol)
//
// The desktop app registers the `codecast://` scheme. A web page running in a
// browser hands off to the app by navigating to one of these links; the app's
// native layer forwards the raw URL to the renderer, where
// `parseDesktopDeepLinkPath` turns it back into an in-app route.
// ---------------------------------------------------------------------------

const DEEP_LINK_HOST = "open";

// `auto: true` marks a machine-initiated handoff (the browser page redirecting
// itself on load) as opposed to the user clicking an "Open in desktop"
// affordance. The desktop treats auto arrivals with suspicion — see
// shouldApplyAutoDeepLink — because nothing distinguishes a user-clicked link
// from an automation-driven tab on the sending side.
export const AUTO_HANDOFF_PARAM = "cc_handoff";

// Build a codecast:// deep link for a root-relative in-app path
// ("/conversation/x?foo=1" → "codecast://open/conversation/x?foo=1").
//
// The real route is nested under a fixed `open` host so the path survives a
// round trip: a bare `codecast://conversation/x` parses "conversation" as the
// URL host and drops it, landing the app on the wrong page.
export function buildDesktopDeepLink(pathWithSearch: string, opts?: { auto?: boolean }): string {
  const p = pathWithSearch.startsWith("/") ? pathWithSearch : `/${pathWithSearch}`;
  if (!opts?.auto) return `codecast://${DEEP_LINK_HOST}${p}`;
  const sep = p.includes("?") ? "&" : "?";
  return `codecast://${DEEP_LINK_HOST}${p}${sep}${AUTO_HANDOFF_PARAM}=auto`;
}

// Split an incoming deep-link path into the navigable path and whether it was
// an auto handoff (stripping the marker so it never reaches the router).
export function extractDeepLinkIntent(pathWithSearch: string): { path: string; auto: boolean } {
  const qIdx = pathWithSearch.indexOf("?");
  if (qIdx === -1) return { path: pathWithSearch, auto: false };
  const sp = new URLSearchParams(pathWithSearch.slice(qIdx + 1));
  const auto = sp.get(AUTO_HANDOFF_PARAM) === "auto";
  sp.delete(AUTO_HANDOFF_PARAM);
  const rest = sp.toString();
  return { path: pathWithSearch.slice(0, qIdx) + (rest ? `?${rest}` : ""), auto };
}

// Inverse of buildDesktopDeepLink: turn an incoming codecast:// URL into a
// root-relative in-app path, or null when there's nothing navigable. Tolerates
// the legacy host-as-segment shape (codecast://conversation/x) by folding a
// non-sentinel host back into the path.
export function parseDesktopDeepLinkPath(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path = u.pathname || "";
  const host = u.hostname;
  if (host && host !== DEEP_LINK_HOST) {
    path = `/${host}${path === "/" ? "" : path}`;
  }
  if (!path || path === "/") return null;
  return path + (u.search || "");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

// Paths that should never auto-hand-off to the desktop app — auth/oauth flows,
// public share pages (often opened by people without the app), published
// artifacts (/a/<slug>, same audience), the in-app palette popup, downloads,
// and API routes.
const HANDOFF_DENY = [/^\/login/, /^\/auth/, /^\/oauth/, /^\/share\//, /^\/a\//, /^\/palette/, /^\/download/, /^\/api\//];

export function isHandoffEligiblePath(path: string): boolean {
  if (!path) return false;
  return !HANDOFF_DENY.some((re) => re.test(path));
}

function isOAuthCallback(search: string): boolean {
  const sp = new URLSearchParams(search || "");
  return sp.has("code") && sp.has("state");
}

// Auto-handoff fires only from the production host. Dev/local origins
// (local.codecast.sh, localhost) host agent-driven Chrome tabs — automation
// that activates a tab in a frontmost window satisfies foreground + fresh
// navigation, and a deep link from there show()+focus()es the desktop app
// onto whatever the agent had open. Manual "open in desktop" affordances
// (buildDesktopDeepLink call sites) are unaffected.
export function isAutoHandoffHost(host: string): boolean {
  return /^(www\.)?codecast\.sh$/i.test(host);
}

// A genuine foreground tab: visible AND the window holds OS focus. The handoff
// gate requires this so it stays inert in background or automated tabs — e.g.
// agent/headless browser tabs that load app pages with no human looking. Those
// must never yank the desktop app to the front (the "Codecast keeps jumping to
// random sessions" bug: every background page-load was firing a deep link).
export function isForegroundTab(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

// A clicked/typed link reads as "navigate"; reload / back-forward should be
// left in the browser. Unknown (no entry) is treated as fresh.
export function isFreshNavigation(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav ? nav.type === "navigate" : true;
  } catch {
    return true;
  }
}

export type HandoffContext = {
  isDesktop: boolean;
  initialized: boolean;
  hasUsedDesktop: boolean;
  preferBrowser: boolean;
  isTopWindow: boolean;
  foreground: boolean;
  host: string;
  freshNavigation: boolean;
  path: string;
  search: string;
  // "Open in browser" was chosen for exactly this URL (sessionStorage, so it
  // lasts for the tab). Distinct from `preferBrowser`, which is the permanent
  // per-user opt-out.
  skippedUrl: string | null;
};

// Whether a browser page should auto-redirect into the desktop app. Pure so the
// full gate is unit-testable; callers just gather the context.
//
// Fires only when: not already in the app, synced prefs have loaded, the user
// owns the app, they haven't opted to stay in the browser, we're the top-level
// foreground window on the PRODUCTION host (never local dev — see
// isAutoHandoffHost), this is a fresh navigation (a clicked/typed link, not a
// reload or back/forward), and the path isn't an auth/share/etc. route.
// `foreground` is split out because the component re-checks the gate on
// focus/visibility: a tab opened in the background (cmd-click) hands off only
// once the user looks at it.
export function shouldAttemptHandoff(c: HandoffContext): boolean {
  if (c.isDesktop) return false;
  if (!c.initialized) return false;
  if (!c.hasUsedDesktop) return false;
  if (c.preferBrowser) return false;
  if (!c.isTopWindow) return false;
  if (!c.foreground) return false;
  if (!isAutoHandoffHost(c.host)) return false;
  if (!c.freshNavigation) return false;
  if (!isHandoffEligiblePath(c.path)) return false;
  if (isOAuthCallback(c.search)) return false;
  if (c.skippedUrl !== null && c.skippedUrl === c.path + c.search) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The pre-boot mirror
//
// The gate above needs two server-synced preferences (has_used_desktop,
// prefer_browser_links) that only exist once the app has booted, connected and
// hydrated — precisely the work the handoff exists to skip. So the running app
// mirrors its *decision* into localStorage, where a script running during HTML
// parse can read it synchronously. The first visit after installing the desktop
// app still takes the slow React path; that visit writes the mirror, and every
// later one is fast.
// ---------------------------------------------------------------------------

export const HANDOFF_MIRROR_KEY = "codecast-desktop-handoff";
// Set to this instead of "1" to also enable the pre-boot handoff on local dev
// hosts. Verification only — a local tab is normally excluded because agents
// drive Chrome there (see isAutoHandoffHost).
export const HANDOFF_MIRROR_DEV = "dev";
// Per-tab: "use the browser for THIS page", stored as the URL it was chosen for.
export const HANDOFF_SKIP_KEY = "codecast-handoff-skip";
// Per-tab: the pre-boot screen took the permanent opt-out, so the app owes the
// server a prefer_browser_links write once it boots.
export const HANDOFF_PERSIST_KEY = "codecast-handoff-prefer-browser";

// Set by the inlined pre-boot script, read by the app entry (src/main.tsx):
// the gate sent this page to the desktop app, so the app must not boot.
const HANDOFF_PENDING_FLAG = "__ccHandoffPending";
// Also set by the pre-boot script: a Promise<boolean> the entry waits on while
// a background tab decides. Resolves true when the tab handed off (no boot),
// false when it should boot after all.
const HANDOFF_HOLD_FLAG = "__ccHandoffHold";
// Drives the static escape-hatch screen in index.html purely through CSS, so
// it appears as soon as the body parses with no further JavaScript involved.
const HANDOFF_SCREEN_ATTR = "data-cc-handoff";
// Set on <html> once "Close this tab" was refused by the browser; reveals the
// keyboard hint on the screen.
const HANDOFF_KEEP_ATTR = "data-cc-handoff-kept";
const ACTION_ATTR = "data-cc-handoff-action";
const MODIFIER_ATTR = "data-cc-handoff-modifier";

// How long a background tab stays armed to hand off once the user looks at it.
// A cmd-clicked tab looked at soon should hand off; a forgotten or
// automation-driven tab focused much later must not detonate a stale handoff
// (agent tabs park on app pages for hours, and any focus of that window would
// yank the desktop app).
export const ARM_WINDOW_MS = 120_000;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Mirror the running app's handoff decision for the next fresh navigation. */
export function writeHandoffMirror(eligible: boolean): void {
  try {
    if (eligible) localStorage.setItem(HANDOFF_MIRROR_KEY, "1");
    else localStorage.removeItem(HANDOFF_MIRROR_KEY);
  } catch {}
}

/** Remember "use the browser for this page" for the rest of the tab session. */
export function skipHandoffForUrl(url: string): void {
  try {
    sessionStorage.setItem(HANDOFF_SKIP_KEY, url);
  } catch {}
}

export function readSkippedUrl(): string | null {
  return readSession(HANDOFF_SKIP_KEY);
}

/**
 * Did the pre-boot screen take the permanent "always use the browser" opt-out?
 * Consumes the flag — the caller owes the server one prefer_browser_links write.
 */
export function takePendingPreferBrowser(): boolean {
  if (readSession(HANDOFF_PERSIST_KEY) !== "1") return false;
  try {
    sessionStorage.removeItem(HANDOFF_PERSIST_KEY);
  } catch {}
  return true;
}

export type PreBootHandoffContext = {
  // localStorage mirror value: "1" = hand off on the production host,
  // "dev" = also on local hosts (verification), null = never.
  mirror: string | null;
  // The desktop app's renderer loads this very same index.html from
  // codecast.sh, so the pre-boot script runs inside the app too and must never
  // fire a deep link at itself.
  isDesktopShell: boolean;
  isTopWindow: boolean;
  foreground: boolean;
  host: string;
  freshNavigation: boolean;
  path: string;
  search: string;
  skippedUrl: string | null;
};

/**
 * The pre-boot gate, expressed entirely in terms of the full gate so the two
 * paths can never diverge. The mirror stands in for the two synced preferences
 * (it is only written when both allow a handoff).
 */
export function shouldAttemptPreBootHandoff(c: PreBootHandoffContext): boolean {
  if (!c.mirror) return false;
  return shouldAttemptHandoff({
    isDesktop: c.isDesktopShell,
    initialized: true,
    hasUsedDesktop: true,
    preferBrowser: false,
    isTopWindow: c.isTopWindow,
    foreground: c.foreground,
    host: c.mirror === HANDOFF_MIRROR_DEV ? "codecast.sh" : c.host,
    freshNavigation: c.freshNavigation,
    path: c.path,
    search: c.search,
    skippedUrl: c.skippedUrl,
  });
}

/**
 * What to do with a page load, given the gate's verdict now and its verdict
 * once the tab is in the foreground. Pure so the three-way split is testable:
 *  - "handoff": send it to the app now.
 *  - "hold": everything but the foreground check passes — wait for the user
 *    to look at the tab before deciding, and don't boot the app meanwhile.
 *  - "boot": some permanent blocker; boot the app as usual.
 */
export type PreBootVerdict = "handoff" | "hold" | "boot";

export function preBootVerdict(c: PreBootHandoffContext): PreBootVerdict {
  if (shouldAttemptPreBootHandoff(c)) return "handoff";
  if (c.foreground) return "boot";
  return shouldAttemptPreBootHandoff({ ...c, foreground: true }) ? "hold" : "boot";
}

// window.__CODECAST_ELECTRON__ is exposed by the desktop preload before any page
// script runs, but the user-agent check keeps this honest even on a build whose
// preload failed to load — a desktop window must never hand off to itself.
// The twin of lib/desktop.ts's isDesktopShell, copied rather than imported
// because this file is inlined pre-boot and may import nothing.
function isDesktopShell(): boolean {
  if ((window as any).__CODECAST_ELECTRON__) return true;
  return typeof navigator !== "undefined" && / Electron\//.test(navigator.userAgent);
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

function readPreBootContext(): PreBootHandoffContext {
  return {
    mirror: readLocal(HANDOFF_MIRROR_KEY),
    isDesktopShell: isDesktopShell(),
    isTopWindow: window.top === window.self,
    foreground: isForegroundTab(),
    host: window.location.host,
    freshNavigation: isFreshNavigation(),
    path: window.location.pathname,
    search: window.location.search,
    skippedUrl: readSkippedUrl(),
  };
}

/** Navigate this page to its desktop deep link. */
export function openDesktop(opts?: { auto?: boolean }): void {
  window.location.href = buildDesktopDeepLink(currentUrl(), opts);
}

/**
 * Wait for a background tab to reach the foreground, then run `attempt` — the
 * caller's gate check plus handoff. Armed only for ARM_WINDOW_MS (see above);
 * `onLapse` runs when the window closes without a handoff. Returns a teardown
 * for the caller that unmounts first.
 */
export function armForegroundHandoff(attempt: () => boolean, onLapse?: () => void): () => void {
  const armedAt = Date.now();
  const teardown = () => {
    clearTimeout(timer);
    window.removeEventListener("focus", onActive);
    document.removeEventListener("visibilitychange", onActive);
  };
  const lapse = () => {
    teardown();
    onLapse?.();
  };
  const onActive = () => {
    if (Date.now() - armedAt > ARM_WINDOW_MS) {
      lapse();
      return;
    }
    if (attempt()) teardown();
  };
  const timer = setTimeout(lapse, ARM_WINDOW_MS);
  window.addEventListener("focus", onActive);
  document.addEventListener("visibilitychange", onActive);
  return teardown;
}

/**
 * Boot the app unless the pre-boot gate took the page over. `boot` runs at
 * once on a normal load, never after a handoff, and only once a held
 * background tab has decided against handing off. Without the inlined gate
 * (dev server without the plugin, a stale shell) nothing is flagged and the
 * app boots as usual.
 */
export function bootAfterHandoffGate(boot: () => void): void {
  const w = window as any;
  if (w[HANDOFF_PENDING_FLAG]) return;
  const hold: Promise<boolean> | undefined = w[HANDOFF_HOLD_FLAG];
  if (!hold) {
    boot();
    return;
  }
  void hold.then((handoff) => {
    if (!handoff) boot();
  });
}

export type HandoffScreenOptions = {
  // Whether the app is running behind the screen. When it is not (the pre-boot
  // takeover), "use the browser" has to reload: the entry module may never have
  // run, because launching the protocol can cut the document load short. When
  // it is, the screen simply goes away, and the permanent opt-out reaches the
  // server through `onAlways` instead of being parked for the next boot.
  booted: boolean;
  onAlways?: () => void;
};

/**
 * Show the static "Opened in Codecast desktop" screen from index.html and wire
 * its actions. Both the inlined pre-boot script and the React fallback use it,
 * so there is exactly one screen. Returns a function that hides it again.
 *
 * Clicks are delegated from `document`, which exists even while the head is
 * still parsing — the buttons are parsed later, and waiting for
 * DOMContentLoaded would never work on the pre-boot path, since launching the
 * protocol interrupts the document load and that event may never fire.
 */
export function showHandoffScreen(opts: HandoffScreenOptions): () => void {
  const root = document.documentElement;
  root.setAttribute(HANDOFF_SCREEN_ATTR, "");
  const hide = () => {
    root.removeAttribute(HANDOFF_SCREEN_ATTR);
    root.removeAttribute(HANDOFF_KEEP_ATTR);
    document.removeEventListener("click", onClick);
  };
  const onClick = (e: Event) => onScreenClick(e, opts, hide);
  document.addEventListener("click", onClick);
  return hide;
}

function onScreenClick(e: Event, opts: HandoffScreenOptions, hide: () => void): void {
  const target = (e.target as Element | null)?.closest?.(`[${ACTION_ATTR}]`);
  const action = target?.getAttribute(ACTION_ATTR);
  if (!action) return;

  if (action === "close") {
    closeTab();
    return;
  }

  if (action === "retry") {
    // Explicitly user-driven, so no auto marker: the desktop applies a clicked
    // link unconditionally.
    openDesktop();
    return;
  }

  if (action === "always") {
    writeHandoffMirror(false);
    if (opts.booted) opts.onAlways?.();
    // Only the running app can reach the server with the preference; park it
    // for whoever boots next.
    else {
      try {
        sessionStorage.setItem(HANDOFF_PERSIST_KEY, "1");
      } catch {}
    }
  }

  // Both "browser" and "always" mean: use the browser for this page. Recorded
  // for the tab so the gate honors it on a reload too, which would otherwise
  // bounce straight back to the app. A reload is a navigation the gate declines
  // twice over (its type is "reload", and the skip names this url).
  skipHandoffForUrl(currentUrl());
  if (opts.booted) hide();
  else window.location.reload();
}

// The page has been handed to the app, so the tab has nothing left to show.
// Browsers let a script close a tab that holds a single document (the shape
// every clicked or cmd-clicked link produces) but refuse for a tab with
// history; then the screen owns up and shows the shortcut instead.
function closeTab(): void {
  const root = document.documentElement;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  for (const el of Array.from(document.querySelectorAll(`[${MODIFIER_ATTR}]`))) {
    el.textContent = isMac ? "⌘" : "Ctrl";
  }
  root.setAttribute(HANDOFF_KEEP_ATTR, "");
  window.close();
}

/**
 * Share pages that boot standalone (src/shareBoot.tsx) instead of the app:
 * /share/message|doc|plan/<token>. /share/<token> is NOT one — it resolves to
 * a conversation and needs the app.
 */
export function isStandaloneSharePath(path: string): boolean {
  return /^\/share\/(message|doc|plan)\/[^/]+\/?$/.test(path);
}

/**
 * The inlined pre-boot entry point. `appPreloadUrls` are the module chunks the
 * app entry will dynamically import; injecting them here keeps a normal load
 * exactly as parallel as it was before the entry was split, while a handoff
 * skips them entirely and fetches nothing.
 *
 * A background tab that would hand off once looked at (a cmd-clicked link, or
 * a link opened from another app before the window has focus) is held: no
 * preload, no boot, until the user looks at it within the arm window — then it
 * hands off with the app never having run — or the window lapses and it boots
 * as a normal tab.
 */
export function runPreBootHandoff(appPreloadUrls: string[], sharePreloadUrls: string[] = []): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let verdict: PreBootVerdict = "boot";
  try {
    verdict = preBootVerdict(readPreBootContext());
  } catch {}

  const preload = () =>
    preloadApp(isStandaloneSharePath(window.location.pathname) ? sharePreloadUrls : appPreloadUrls);

  if (verdict === "boot") {
    preload();
    return;
  }

  if (verdict === "handoff") {
    takeOverBoot();
    return;
  }

  (window as any)[HANDOFF_HOLD_FLAG] = new Promise<boolean>((resolve) => {
    armForegroundHandoff(
      () => {
        let go = false;
        try {
          go = shouldAttemptPreBootHandoff(readPreBootContext());
        } catch {}
        if (!go) return false;
        takeOverBoot();
        resolve(true);
        return true;
      },
      () => {
        preload();
        resolve(false);
      },
    );
  });
}

function takeOverBoot(): void {
  (window as any)[HANDOFF_PENDING_FLAG] = true;
  showHandoffScreen({ booted: false });
  // Yield to the parser so the escape-hatch markup is in the DOM before the
  // protocol launch interrupts the load. The document is a few kilobytes, so
  // this costs about a millisecond.
  setTimeout(() => openDesktop({ auto: true }), 0);
}

function preloadApp(urls: string[]): void {
  for (const href of urls) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    // Matches the crossorigin attribute Vite puts on its own preload hints, so
    // the module fetch reuses the preloaded response instead of repeating it.
    link.crossOrigin = "anonymous";
    link.href = href;
    document.head.appendChild(link);
  }
}

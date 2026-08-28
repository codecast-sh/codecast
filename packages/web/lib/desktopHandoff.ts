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
 *     localStorage mirror exists, and a tab that only reaches the foreground
 *     later.
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

// Set by the inlined pre-boot script, read by the app entry (src/main.tsx).
const HANDOFF_PENDING_FLAG = "__ccHandoffPending";
// Drives the static escape-hatch screen in index.html purely through CSS, so it
// appears as soon as the body parses with no further JavaScript involved.
const HANDOFF_SCREEN_ATTR = "data-cc-handoff";
const ACTION_ATTR = "data-cc-handoff-action";

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

// window.__CODECAST_ELECTRON__ is exposed by the desktop preload before any page
// script runs, but the user-agent check keeps this honest even on a build whose
// preload failed to load — a desktop window must never hand off to itself.
function isDesktopShell(): boolean {
  if ((window as any).__CODECAST_ELECTRON__) return true;
  return typeof navigator !== "undefined" && / Electron\//.test(navigator.userAgent);
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/**
 * True when the pre-boot gate already sent this page to the desktop app, so the
 * app entry must not boot — that is the whole point. The escape-hatch buttons on
 * the static screen reload the page instead of booting in place, because the
 * protocol launch can cut the entry module's own fetch short (Chrome interrupts
 * the document load), leaving nothing to call.
 */
export function handoffTookOverBoot(): boolean {
  return typeof window !== "undefined" && !!(window as any)[HANDOFF_PENDING_FLAG];
}

/**
 * The inlined pre-boot entry point. `appPreloadUrls` are the module chunks the
 * app entry will dynamically import; injecting them here keeps a normal load
 * exactly as parallel as it was before the entry was split, while a handoff
 * skips them entirely and fetches nothing.
 */
/**
 * Share pages that boot standalone (src/shareBoot.tsx) instead of the app:
 * /share/message|doc|plan/<token>. /share/<token> is NOT one — it resolves to
 * a conversation and needs the app.
 */
export function isStandaloneSharePath(path: string): boolean {
  return /^\/share\/(message|doc|plan)\/[^/]+\/?$/.test(path);
}

export function runPreBootHandoff(appPreloadUrls: string[], sharePreloadUrls: string[] = []): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let handoff = false;
  try {
    handoff = shouldAttemptPreBootHandoff({
      mirror: readLocal(HANDOFF_MIRROR_KEY),
      isDesktopShell: isDesktopShell(),
      isTopWindow: window.top === window.self,
      foreground: isForegroundTab(),
      host: window.location.host,
      freshNavigation: isFreshNavigation(),
      path: window.location.pathname,
      search: window.location.search,
      skippedUrl: readSkippedUrl(),
    });
  } catch {}

  if (!handoff) {
    preloadApp(isStandaloneSharePath(window.location.pathname) ? sharePreloadUrls : appPreloadUrls);
    return;
  }

  (window as any)[HANDOFF_PENDING_FLAG] = true;
  document.documentElement.setAttribute(HANDOFF_SCREEN_ATTR, "");

  // Delegated from `document`, which exists right now — the buttons are parsed
  // later, and waiting for DOMContentLoaded would never work: launching the
  // protocol interrupts the document load, so that event may never fire.
  document.addEventListener("click", onScreenClick);

  // Yield to the parser so the escape-hatch markup is in the DOM before the
  // protocol launch interrupts the load. The document is a few kilobytes, so
  // this costs about a millisecond.
  setTimeout(() => openDesktop({ auto: true }), 0);
}

function openDesktop(opts?: { auto?: boolean }): void {
  window.location.href = buildDesktopDeepLink(currentUrl(), opts);
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

function onScreenClick(e: Event): void {
  const target = (e.target as Element | null)?.closest?.(`[${ACTION_ATTR}]`);
  const action = target?.getAttribute(ACTION_ATTR);
  if (!action) return;

  if (action === "retry") {
    // Explicitly user-driven, so no auto marker: the desktop applies a clicked
    // link unconditionally.
    openDesktop();
    return;
  }

  if (action === "always") {
    writeHandoffMirror(false);
    // Only the running app can reach the server with the preference; park it.
    try {
      sessionStorage.setItem(HANDOFF_PERSIST_KEY, "1");
    } catch {}
  }

  // Both "browser" and "always" mean: use the browser for this page. Reloading
  // is what starts the app — the entry module may never have run, and a reload
  // is a navigation the gate declines twice over (its type is "reload", and the
  // skip below names this url).
  skipHandoffForUrl(currentUrl());
  window.location.reload();
}

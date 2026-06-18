declare global {
  interface Window {
    __CODECAST_ELECTRON__?: {
      getVersion: () => Promise<string>;
      setBadgeCount: (count: number) => Promise<void>;
      onDeepLink: (cb: (url: string) => void) => void;
      onUpdateStatus: (cb: (status: { status: string; version?: string; percent?: number }) => void) => void;
      restartForUpdate: () => Promise<void>;
      checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
      showNotification: (title: string, body: string, data?: { conversationId?: string }) => Promise<void>;
      getShortcuts: () => Promise<Record<string, string>>;
      setShortcut: (key: string, accelerator: string) => Promise<Record<string, string>>;
      paletteNavigate: (path: string) => void;
      paletteHide: () => void;
      paletteNewSession: () => void;
      paletteReady: (mode: "compose" | "search") => void;
      onPaletteShow: (cb: () => void) => () => void;
      // Compose popup (floating new-session window):
      onComposeShow: (cb: () => void) => () => void;
      composeSubmit: (data: { conversationId?: string; navigate: boolean }) => void;
      platform: string;
    };
  }
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.__CODECAST_ELECTRON__;
}

// Resolve an Electron bridge method, returning undefined when it isn't present.
// The runtime `typeof fn === "function"` check is what makes callers safe on
// OLDER desktop builds whose preload predates a given method (e.g. composeSubmit
// on builds before the compose popup shipped) — the typings declare every method
// as required, so a bare `?.method?.()` would silently no-op instead of letting
// the caller fall back.
export function bridge<K extends keyof NonNullable<Window["__CODECAST_ELECTRON__"]>>(
  method: K,
): NonNullable<Window["__CODECAST_ELECTRON__"]>[K] | undefined {
  const b = window.__CODECAST_ELECTRON__;
  const fn = b?.[method];
  return typeof fn === "function" ? fn.bind(b) as any : undefined;
}

export function isDesktop(): boolean {
  return isElectron();
}

// ---------------------------------------------------------------------------
// Deep links (codecast:// custom protocol)
//
// The desktop app registers the `codecast://` scheme. A web page running in a
// browser hands off to the app by navigating to one of these links; the app's
// native layer forwards the raw URL to the renderer, where `parseDesktopDeepLinkPath`
// turns it back into an in-app route.
// ---------------------------------------------------------------------------

const DEEP_LINK_HOST = "open";

// Build a codecast:// deep link for a root-relative in-app path
// ("/conversation/x?foo=1" → "codecast://open/conversation/x?foo=1").
//
// The real route is nested under a fixed `open` host so the path survives a
// round trip: a bare `codecast://conversation/x` parses "conversation" as the
// URL host and drops it, landing the app on the wrong page.
//
// `auto: true` marks a machine-initiated handoff (the browser page redirecting
// itself on load) as opposed to the user clicking an "Open in desktop"
// affordance. The desktop treats auto arrivals with suspicion — see
// shouldApplyAutoDeepLink — because nothing distinguishes a user-clicked link
// from an automation-driven tab on the sending side.
export const AUTO_HANDOFF_PARAM = "cc_handoff";

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

// --- Desktop user-activity tracker -----------------------------------------
// An auto handoff may move the desktop's view only when the user is NOT in the
// middle of using it: a background tab (often automation — agents drive Chrome
// with the user's own profile) firing a handoff while the user types here must
// not yank the view. Installed once by DesktopProvider.
let lastDesktopInputAt = 0;
export function installDesktopInputTracker(): void {
  if (typeof window === "undefined") return;
  const note = () => { lastDesktopInputAt = Date.now(); };
  window.addEventListener("pointerdown", note, { capture: true, passive: true });
  window.addEventListener("keydown", note, { capture: true, passive: true });
}

const AUTO_DEEPLINK_QUIET_MS = 30_000;

// Pure policy, unit-testable: a manual link always applies; an auto handoff
// applies only when the desktop has been quiet (no local input) long enough
// that moving the view cannot interrupt anything.
export function shouldApplyAutoDeepLink(now: number = Date.now(), lastInputAt: number = lastDesktopInputAt): boolean {
  return now - lastInputAt > AUTO_DEEPLINK_QUIET_MS;
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

// Paths that should never auto-hand-off to the desktop app — auth/oauth flows,
// public share pages (often opened by people without the app), the in-app
// palette popup, downloads, and API routes.
const HANDOFF_DENY = [/^\/login/, /^\/auth/, /^\/oauth/, /^\/share\//, /^\/palette/, /^\/download/, /^\/api\//];

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
};

// Whether a browser page should auto-redirect into the desktop app. Pure so the
// full gate is unit-testable; the component just gathers the context.
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
  return true;
}

export function hasBrowserNotificationPermission(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (isDesktop()) return true;
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export async function notifyNative(title: string, body: string, data?: { conversationId?: string }) {
  if (isElectron()) {
    bridge("showNotification")?.(title, body, data);
  } else if (hasBrowserNotificationPermission()) {
    if (document.hasFocus()) return;
    const n = new Notification(title, { body, icon: "/icon-192.png", tag: data?.conversationId });
    if (data?.conversationId) {
      n.onclick = () => {
        window.focus();
        window.location.href = `/conversation/${data.conversationId}`;
      };
    }
  }
}

export async function updateBadge(count: number) {
  if (isElectron()) {
    bridge("setBadgeCount")?.(count);
  }
}

export async function onDeepLink(cb: (urls: string[]) => void) {
  if (isElectron()) {
    bridge("onDeepLink")?.((url: string) => cb([url]));
  }
}

export function onUpdateStatus(cb: (status: { status: string; version?: string; percent?: number }) => void) {
  if (isElectron()) {
    bridge("onUpdateStatus")?.(cb);
  }
}

export function restartForUpdate() {
  if (isElectron()) {
    bridge("restartForUpdate")?.();
  }
}

// Ask the desktop app to check the feed now. `manual: true` makes it surface a
// native "up to date" / "ready" / "failed" notification (undefined on older
// builds whose preload predates this method — callers fall back gracefully).
export function checkForUpdate(opts?: { manual?: boolean }) {
  if (isElectron()) {
    bridge("checkForUpdate")?.(opts);
  }
}

// True on desktop builds that carry the in-process updater (download-with-
// progress + foreground swap-on-restart). False on the web and on older builds
// whose preload predates `checkForUpdate` — there the banner falls back to the
// daemon-driven update path (server mutation → daemon swap).
export function hasInProcessUpdater(): boolean {
  return isElectron() && typeof window.__CODECAST_ELECTRON__?.checkForUpdate === "function";
}

export function desktopHeaderClass(): string {
  if (typeof window === "undefined") return "";
  if (isElectron()) return "electron-drag-region pl-[78px]";
  return "";
}

export function useIsDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return isDesktop();
}

export function setupDesktopDrag(_el: HTMLElement): (() => void) | undefined {
  return;
}

export async function checkForUpdates() {
  // Electron auto-update is handled in main process
}

export async function getAppVersion(): Promise<string | null> {
  if (isElectron()) {
    return bridge("getVersion")?.() ?? null;
  }
  return null;
}

// Numeric semver compare (mirrors the daemon's compareVersions).
function cmpVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Latest published desktop version, from our own server (same-origin — avoids a
// cross-origin fetch to the R2 feed). Bumped with every desktop release.
export async function getLatestDesktopVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/desktop/latest", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

// { current, latest } when the running desktop app is behind the published
// version, else null (also null on web / non-desktop).
export async function checkDesktopUpdate(): Promise<{ current: string; latest: string } | null> {
  if (!isDesktop()) return null;
  const [current, latest] = await Promise.all([getAppVersion(), getLatestDesktopVersion()]);
  if (!current || !latest) return null;
  return cmpVersions(latest, current) > 0 ? { current, latest } : null;
}

// Pause CSS animations while the desktop window is in the background.
//
// The desktop app runs with backgroundThrottling disabled (electron/main.js) so
// the Convex live-query socket keeps delivering while the window is hidden. The
// side effect: Chromium also keeps compositing every infinite CSS animation (the
// per-session pulse/ping/spin status dots) at the full display refresh rate even
// when Codecast is sitting unfocused behind another app — pinning the GPU process
// for nothing visible. Toggling one attribute on <html> on focus/visibility
// changes lets a single CSS rule park those animations; JS and the socket keep
// running, so live data still flows and everything resumes instantly on focus.
export function installIdleAnimationPause(): void {
  if (typeof window === "undefined" || !isElectron()) return;
  const root = document.documentElement;
  const update = () => {
    const idle = !document.hasFocus() || document.visibilityState === "hidden";
    root.toggleAttribute("data-idle", idle);
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
}

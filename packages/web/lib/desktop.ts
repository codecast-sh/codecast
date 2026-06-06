import { isAppHost } from "./entityLinks";

declare global {
  interface Window {
    __CODECAST_ELECTRON__?: {
      getVersion: () => Promise<string>;
      setBadgeCount: (count: number) => Promise<void>;
      onDeepLink: (cb: (url: string) => void) => void;
      onUpdateStatus: (cb: (status: { status: string; version?: string; percent?: number }) => void) => void;
      restartForUpdate: () => Promise<void>;
      showNotification: (title: string, body: string, data?: { conversationId?: string }) => Promise<void>;
      getShortcuts: () => Promise<Record<string, string>>;
      setShortcut: (key: string, accelerator: string) => Promise<Record<string, string>>;
      paletteNavigate: (path: string) => void;
      paletteHide: () => void;
      paletteNewSession: () => void;
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
export function buildDesktopDeepLink(pathWithSearch: string): string {
  const p = pathWithSearch.startsWith("/") ? pathWithSearch : `/${pathWithSearch}`;
  return `codecast://${DEEP_LINK_HOST}${p}`;
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

export type HandoffContext = {
  isDesktop: boolean;
  initialized: boolean;
  hasUsedDesktop: boolean;
  preferBrowser: boolean;
  isTopWindow: boolean;
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
// window on one of our own hosts (prod or local dev — they share the backend),
// this is a fresh navigation (a clicked/typed link, not a reload or
// back/forward), and the path isn't an auth/share/etc. route.
export function shouldAttemptHandoff(c: HandoffContext): boolean {
  if (c.isDesktop) return false;
  if (!c.initialized) return false;
  if (!c.hasUsedDesktop) return false;
  if (c.preferBrowser) return false;
  if (!c.isTopWindow) return false;
  if (!isAppHost(c.host)) return false;
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

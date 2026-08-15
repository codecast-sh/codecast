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
      getShortcutConfig: () => Promise<DesktopShortcutConfig>;
      setShortcut: (key: string, accelerator: string) => Promise<Record<string, string>>;
      paletteNavigate: (path: string) => void;
      paletteHide: () => void;
      paletteNewSession: () => void;
      paletteReady: (mode: "compose" | "search") => void;
      onPaletteShow: (cb: () => void) => () => void;
      // Compose popup (floating new-session window):
      onComposeShow: (cb: () => void) => () => void;
      composeSubmit: (data: { conversationId?: string; navigate: boolean }) => void;
      // Open an https URL in the system default browser (used by the
      // browser-based desktop sign-in). Absent on older builds — gate on it.
      openExternal: (url: string) => Promise<void>;
      // Machine-wide seconds since last user input (Electron powerMonitor).
      // Absent on older builds — gate on it.
      getSystemIdleSeconds: () => Promise<number>;
      // Detached tab windows: a dashboard tab broken out into its own OS
      // window. All absent on older builds — gate on them.
      isTabWindow?: boolean;
      detachTab: (path: string) => Promise<void>;
      attachTab: (path: string) => Promise<void>;
      onAdoptTab: (cb: (path: string) => void) => void;
      // Screen-share primitives (huddles). The shell lists capturable
      // screens/windows and lets the web pre-select one for the NEXT
      // getDisplayMedia; the picker UI itself is web-owned. Absent on older
      // builds — gate on them (a missing selectDisplaySource means the shell
      // captures the primary screen on its own).
      getDisplaySources?: (opts?: { types?: Array<"screen" | "window"> }) => Promise<DesktopDisplaySource[]>;
      selectDisplaySource?: (id: string | null) => Promise<boolean>;
      // Read (no arg) or additively extend (patch) the shell's capability
      // grant table. Persisted in the shell's settings; lets the web layer
      // light up a new permission-gated feature without a desktop release.
      // Absent on older builds — gate on it.
      hostPolicy?: (patch?: { permissions?: string[]; hosts?: string[] }) => Promise<{
        permissions: string[];
        hosts: string[];
        version: string;
      } | null>;
      platform: string;
    };
  }
}

export type DesktopDisplaySource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** data: URL thumbnail, ~320px wide. */
  thumbnail: string;
};

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

// This renderer is a DETACHED TAB WINDOW — one dashboard surface broken out
// into its own OS window (main.js createTabWindow, flagged via preload argv).
// Such a window renders its route directly with no tab shell of its own, and
// must never write shared tab state or persist layout — the main window owns
// both. Checked by the tab router, TabBar, DashboardLayout and the store.
export function isDetachedTabWindow(): boolean {
  return typeof window !== "undefined" && window.__CODECAST_ELECTRON__?.isTabWindow === true;
}

// ---------------------------------------------------------------------------
// OS-global shortcuts (Electron globalShortcut) — the bindings that work from
// any app, not just inside Codecast. One metadata list feeds both the desktop
// settings page and the keyboard shortcuts help panel.
// ---------------------------------------------------------------------------

export const DESKTOP_SHORTCUTS: { key: string; label: string; description: string }[] = [
  { key: "newSession", label: "New Session", description: "Open the new-session compose popup from any app" },
  { key: "toggleWindow", label: "Toggle Main Window", description: "Show or hide the main Codecast window" },
  { key: "togglePalette", label: "Quick Command Palette", description: "Open the floating command palette from anywhere" },
  { key: "toggleEnv", label: "Switch Local / Prod", description: "Switch between local dev and production" },
];

export type DesktopShortcutConfig = {
  shortcuts: Record<string, string>;
  // null on older desktop builds whose preload predates get-shortcut-config —
  // callers hide default-dependent affordances (reset) rather than guessing.
  defaults: Record<string, string> | null;
  // Bindings that failed to register (another app owns the accelerator).
  issues: Record<string, string>;
};

export async function getDesktopShortcutConfig(): Promise<DesktopShortcutConfig | null> {
  if (!isElectron()) return null;
  const full = bridge("getShortcutConfig");
  if (full) return await full();
  const shortcuts = await bridge("getShortcuts")?.();
  return shortcuts ? { shortcuts, defaults: null, issues: {} } : null;
}

// ---------------------------------------------------------------------------
// Browser → desktop hand-off (codecast:// deep links).
//
// The contract — link format, the gate that decides whether a browser page
// should redirect into the app, the localStorage mirror, and the pre-boot runner
// that fires the link before any app chunk is fetched — lives in
// ./desktopHandoff, which stays import-free because it is ALSO inlined into
// index.html's <head>. Re-exported here so callers keep a single desktop entry
// point.
// ---------------------------------------------------------------------------

export {
  AUTO_HANDOFF_PARAM,
  buildDesktopDeepLink,
  extractDeepLinkIntent,
  parseDesktopDeepLinkPath,
  isHandoffEligiblePath,
  isAutoHandoffHost,
  isForegroundTab,
  isFreshNavigation,
  shouldAttemptHandoff,
  shouldAttemptPreBootHandoff,
  writeHandoffMirror,
  skipHandoffForUrl,
  readSkippedUrl,
  takePendingPreferBrowser,
  handoffTookOverBoot,
  runPreBootHandoff,
  HANDOFF_MIRROR_KEY,
  HANDOFF_MIRROR_DEV,
  HANDOFF_SKIP_KEY,
  HANDOFF_PERSIST_KEY,
  type HandoffContext,
  type PreBootHandoffContext,
} from "./desktopHandoff";

// The conversation a root-relative in-app path points at, or null for any
// other page. Shared by deep-link navigation and the handoff notice so the
// two can't disagree about what a path targets.
export function conversationIdFromPath(path: string): string | null {
  return path.match(/^\/conversation\/([^/?#]+)/)?.[1] ?? null;
}

// --- Desktop user-activity tracker -----------------------------------------
// An auto handoff may move the desktop's view only when the user is NOT in the
// middle of using it: a background tab (often automation — agents drive Chrome
// with the user's own profile) firing a handoff while the user types here must
// not yank the view. Installed once by DesktopProvider.
let lastDesktopInputAt = 0;
let inputTrackerInstalled = false;
export function installDesktopInputTracker(): void {
  if (typeof window === "undefined" || inputTrackerInstalled) return;
  inputTrackerInstalled = true;
  const note = () => { lastDesktopInputAt = Date.now(); };
  window.addEventListener("pointerdown", note, { capture: true, passive: true });
  window.addEventListener("keydown", note, { capture: true, passive: true });
}

// 0 until the first input after page load. Consumers that need "activity"
// rather than strictly "input" (presence) should combine this with their own
// signals (focus changes) — see usePresenceReporter.
export function getLastDesktopInputAt(): number {
  return lastDesktopInputAt;
}

// Milliseconds since the machine's last user input. On Electron this is the
// OS-wide answer (powerMonitor), so it stays correct while Codecast sits
// unfocused behind another app. In a browser we only see input on our own
// page — callers pass their best in-page activity floor.
export async function getIdleMs(inPageActivityFloor: number): Promise<number> {
  if (isElectron()) {
    const fn = bridge("getSystemIdleSeconds");
    if (fn) {
      try {
        return (await fn()) * 1000;
      } catch { /* fall through to in-page signal */ }
    }
  }
  const last = Math.max(lastDesktopInputAt, inPageActivityFloor);
  return last > 0 ? Date.now() - last : Number.MAX_SAFE_INTEGER;
}

const AUTO_DEEPLINK_QUIET_MS = 30_000;

// Pure policy, unit-testable: a manual link always applies; an auto handoff
// applies only when the desktop has been quiet (no local input) long enough
// that moving the view cannot interrupt anything.
export function shouldApplyAutoDeepLink(now: number = Date.now(), lastInputAt: number = lastDesktopInputAt): boolean {
  return now - lastInputAt > AUTO_DEEPLINK_QUIET_MS;
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
  // OS notifications are for the unfocused app: when the window has focus the
  // user already sees the bell/inbox update (and hears the idle sound), so a
  // native banner on top is noise. Applies to desktop and browser alike.
  if (typeof document !== "undefined" && document.hasFocus()) return;
  if (isElectron()) {
    bridge("showNotification")?.(title, body, data);
  } else if (hasBrowserNotificationPermission()) {
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

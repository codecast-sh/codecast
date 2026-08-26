declare global {
  interface Window {
    __CODECAST_ELECTRON__?: {
      getVersion: () => Promise<string>;
      setBadgeCount: (count: number) => Promise<void>;
      onDeepLink: (cb: (url: string) => void) => void;
      onUpdateStatus: (cb: (status: { status: string; version?: string; percent?: number }) => void) => void;
      restartForUpdate: () => Promise<void>;
      checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
      // Resolves { shown } on builds with multi-window routing (undefined on
      // older builds, which always showed the banner).
      showNotification: (
        title: string,
        body: string,
        data?: NotifyNativeData,
      ) => Promise<{ shown: boolean; reason?: string } | void>;
      // Multi-window notification routing (see main.js). Absent on older
      // builds — gate on them; without them this window behaves as the only one.
      reportWindowState?: (state: DesktopWindowState) => void;
      onWindowRole?: (cb: (role: DesktopWindowRole) => void) => void;
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
      // The people window (the floating buddy list at /people). A singleton:
      // openPeopleWindow focuses the one that exists. setAlwaysOnTop resolves
      // the pin the shell actually applied — it is honored only from the people
      // window, so any other window gets false back. Absent on older builds —
      // gate on them (isPeopleWindow is then undefined, i.e. not one).
      isPeopleWindow?: boolean;
      openPeopleWindow?: () => Promise<void>;
      setAlwaysOnTop?: (on: boolean) => Promise<boolean>;
      getAlwaysOnTop?: () => Promise<boolean>;
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

// What a banner carries besides its text. `key` is a stable id for the event
// (a notification row id, `ring:<invite>`) so every window reporting the same
// event collapses to one banner; `kind` hints the click target for banners
// with no route ("call" → the window hosting the call / the calls page).
export type NotifyNativeData = { conversationId?: string; route?: string; key?: string; kind?: string };

// What this window shows, reported to the desktop shell so a banner click can
// land in the best window: the active surface path, every surface it could
// switch to (the main window's tabs), and whether it hosts a connected call.
export type DesktopWindowState = {
  active: string | null;
  open: Array<{ id: string | null; path: string }>;
  inCall: boolean;
};

// This window's role among the desktop's windows, pushed by the shell.
//   leader:       the ONE window that may play notification sounds
//   appFocused:   some app window (not just this one) has OS focus
//   anyInCall:    some window hosts a connected call
//   peopleWindow: a people window exists somewhere in the app. The window that
//                 IS it (isPeopleWindow) owns the roster, the call and walkie
//                 pumps and their sounds; the others stand down from them.
export type DesktopWindowRole = {
  leader: boolean;
  appFocused: boolean;
  anyInCall: boolean;
  peopleWindow: boolean;
};

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
// The people window: the floating buddy list — roster, status and calling in a
// window of its own, like an AIM buddy list. On the desktop the shell owns it
// (main.js createPeopleWindow); in a browser it is a popup of the same route.
// ---------------------------------------------------------------------------

export const PEOPLE_ROUTE = "/people";

/** What every surface calls the gesture, so three of them cannot call it three
 *  different things. */
export const POP_OUT_PEOPLE_TITLE = "Pop out the people window";

// This renderer IS the people window. It draws the panel, mounts the call,
// walkie and ring pumps, and (on the desktop) is the shell's notification
// leader while it lives. Every other window stands down from those.
export function isPeopleWindow(): boolean {
  return typeof window !== "undefined" && window.__CODECAST_ELECTRON__?.isPeopleWindow === true;
}

// A people window exists somewhere — this one or another. True inside the
// people window itself, so a caller can ask "is the panel up anywhere?" with
// one question. Before the shell's first role push (and outside the desktop)
// only this window's own flag can answer.
export function hasPeopleWindow(): boolean {
  return isPeopleWindow() || windowRole.peopleWindow;
}

// Open the buddy list, or focus the one already open. Resolves false only when
// a browser blocked the popup — the caller can then fall back to the route.
export async function openPeopleWindow(): Promise<boolean> {
  const open = bridge("openPeopleWindow");
  if (open) {
    await open();
    return true;
  }
  if (typeof window === "undefined") return false;
  // Browser: the same route in a named popup, so a second click raises the
  // window it already opened instead of stacking another.
  const ref = window.open(PEOPLE_ROUTE, "codecast-people", "popup,width=320,height=640");
  ref?.focus();
  return !!ref;
}

// The pin: float this window above other apps. Only the desktop people window
// may, so this resolves the pin the shell actually applied — false everywhere
// else, including a browser popup, where the caller hides the control.
export async function setAlwaysOnTop(on: boolean): Promise<boolean> {
  return (await bridge("setAlwaysOnTop")?.(on)) ?? false;
}

export async function getAlwaysOnTop(): Promise<boolean> {
  return (await bridge("getAlwaysOnTop")?.()) ?? false;
}

// Whether this window can be pinned at all (an older shell has no pin).
export function canPin(): boolean {
  return isPeopleWindow() && typeof window.__CODECAST_ELECTRON__?.setAlwaysOnTop === "function";
}

/**
 * Send a navigation to the MAIN window and raise it.
 *
 * A satellite window — the palette, the compose popup, the buddy list — is a
 * place you stand, not a place you browse. Clicking a person in it must open
 * the conversation where the work already is, in the window that holds the
 * work, and leave the satellite showing what it was showing.
 *
 * The shell's verb is named for the palette because that was its first caller;
 * what it DOES is show the main window, focus it, and hand it the path. A
 * browser popup has no shell, so its opener plays that part.
 *
 * Returns false when there is no other window to send it to — a bare tab on
 * /people, say — so the caller can navigate itself rather than swallow the
 * click and look broken.
 */
export function navigateMainWindow(path: string): boolean {
  const send = bridge("paletteNavigate");
  if (send) {
    send(path);
    return true;
  }
  if (typeof window === "undefined") return false;
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return false;
  try {
    // A real navigation, not an event: the opener only listens for
    // `codecast-navigate` on the desktop, and a popup's opener is a browser
    // tab. Same origin, so this is allowed; the app boots from its local cache,
    // so the tab lands on the DM rather than on a loading screen.
    opener.location.href = path;
    opener.focus();
    return true;
  } catch {
    // A cross-origin or already-navigated-away opener. Not ours to move.
    return false;
  }
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
// Two clocks, on purpose, because two consumers ask different questions.
//
// INPUT is a committed gesture: a click or a keystroke. Auto handoff asks
// "may I move the view", and only a committed gesture should say no — a
// resting hand nudging the mouse must not block a handoff for ever.
//
// ACTIVITY is "a person is here", which is what presence reports. Scrolling a
// long conversation with a trackpad is that, and pointerdown/keydown cannot
// see it: read for the three minutes of INPUT_ACTIVE_MS without clicking and
// the whole team watched you go idle while you were plainly using the app.
// The desktop never had this, because Electron answers with the OS-wide
// powerMonitor idle, which counts a moving mouse. Only the browser was blind,
// and only to the gestures that leave no mark.
//
// wheel and pointermove and nothing else: both are unambiguously human. A
// `scroll` listener would have been the obvious third and is exactly wrong —
// the app auto-scrolls a streaming conversation on its own, and that would
// pin an empty room "active" for as long as an agent kept talking.
let lastDesktopActivityAt = 0;
let inputTrackerInstalled = false;
export function installDesktopInputTracker(): void {
  if (typeof window === "undefined" || inputTrackerInstalled) return;
  inputTrackerInstalled = true;
  const note = () => {
    lastDesktopInputAt = Date.now();
    lastDesktopActivityAt = lastDesktopInputAt;
  };
  const noteActivity = () => { lastDesktopActivityAt = Date.now(); };
  window.addEventListener("pointerdown", note, { capture: true, passive: true });
  window.addEventListener("keydown", note, { capture: true, passive: true });
  window.addEventListener("wheel", noteActivity, { capture: true, passive: true });
  window.addEventListener("pointermove", noteActivity, { capture: true, passive: true });
}

// 0 until the first input after page load. Consumers that need "activity"
// rather than strictly "input" (presence) should combine this with their own
// signals (focus changes) — see usePresenceReporter.
export function getLastDesktopInputAt(): number {
  return lastDesktopInputAt;
}

/** The widest honest "a person is at this page" signal — see above. */
export function getLastDesktopActivityAt(): number {
  return lastDesktopActivityAt;
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
  const last = Math.max(lastDesktopActivityAt, inPageActivityFloor);
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

// Resolves true when THIS window announced the event to the user — the caller
// may pair a sound with it. False when the app is focused (the toast/bell
// layer owns that case) or, on desktop, when another window already showed
// the same banner (the shell dedupes by `data.key`).
export async function notifyNative(
  title: string,
  body: string,
  data?: NotifyNativeData,
): Promise<boolean> {
  // OS notifications are for the unfocused app: when the window has focus the
  // user already sees the bell/inbox update (and hears the idle sound), so a
  // native banner on top is noise. Applies to desktop and browser alike.
  if (typeof document !== "undefined" && document.hasFocus()) return false;
  // One click target per banner: an explicit route (chat, tasks, docs) wins,
  // else the conversation. Electron receives both and applies the same rule.
  const route = data?.route ?? (data?.conversationId ? `/conversation/${data.conversationId}` : undefined);
  if (isElectron()) {
    const res = await bridge("showNotification")?.(title, body, { ...data, route });
    // Older shells resolve void: they showed it.
    return res ? res.shown : true;
  }
  if (hasBrowserNotificationPermission()) {
    const n = new Notification(title, { body, icon: "/icon-192.png", tag: data?.conversationId ?? route });
    if (route) {
      n.onclick = () => {
        window.focus();
        window.location.href = route;
      };
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Window role. The desktop can run several windows of this app (main +
// detached tabs); the shell elects one leader for notification sounds and
// tells each window whether the app as a whole is focused. Outside the desktop
// (or before the shell's first push) this window is the only one: leader.
// ---------------------------------------------------------------------------

let windowRole: DesktopWindowRole = { leader: true, appFocused: false, anyInCall: false, peopleWindow: false };
let windowRoleTracked = false;

export function getDesktopWindowRole(): DesktopWindowRole {
  return windowRole;
}

// True when this window should be the one that sounds a notification.
export function isNotificationLeader(): boolean {
  return windowRole.leader;
}

// Watchers of the role above. The sound paths ASK for the role at the moment
// they need it, so a plain module variable was enough; a surface that DRAWS it
// (the people window's pin, the "in a huddle in another window" pill) has to
// learn when it changes. The snapshot is replaced wholesale on every push, so
// useSyncExternalStore can compare refs.
const windowRoleWatchers = new Set<() => void>();

export function subscribeWindowRole(cb: () => void): () => void {
  windowRoleWatchers.add(cb);
  return () => {
    windowRoleWatchers.delete(cb);
  };
}

// Subscribe once (DesktopProvider) so the role above tracks the shell.
export function installWindowRoleTracker(): void {
  if (windowRoleTracked) return;
  windowRoleTracked = true;
  bridge("onWindowRole")?.((role) => {
    windowRole = {
      leader: role.leader !== false,
      appFocused: !!role.appFocused,
      anyInCall: !!role.anyInCall,
      peopleWindow: !!role.peopleWindow,
    };
    for (const cb of windowRoleWatchers) cb();
  });
}

// Tell the shell what this window shows (no-op outside the desktop).
export function reportDesktopWindowState(state: DesktopWindowState): void {
  bridge("reportWindowState")?.(state);
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
  if (isElectron()) return "electron-drag-region pl-[var(--titlebar-inset)]";
  return "";
}

// The macOS traffic lights sit at x:16,y:12 (main.js trafficLightPosition),
// three 12px lights 20px apart — they end at x=68, y=24. A row whose top is
// below them is clear of them. --titlebar-inset in globals.css is the CSS twin.
const TRAFFIC_LIGHTS_W = 78;
const TRAFFIC_LIGHTS_H = 24;
// Rows starting within this band act as the titlebar (drag surface).
const TITLEBAR_H = 36;

// Zen mode hides the global header, yet a desktop window still needs a
// surface to drag by and the traffic lights cleared. Rather than a dedicated
// strip, the top row of whatever surface is showing plays that role: while it
// lies in the titlebar band it becomes the drag region (the .titlebar-head
// rules), and when it also sits at the window's left edge it indents past the
// lights. Both are measured, not declared, because which row is topmost and
// leftmost depends on layout — a tab bar, a breadcrumb trail, or a rail may or
// may not be open. Re-measured when the row resizes (horizontal layout changes
// reach it that way) and when it moves through the band (an IntersectionObserver
// whose root is the band — vertical shifts from rows appearing above it).
export function attachTitlebarHead(el: HTMLElement): () => void {
  const measure = () => {
    const r = el.getBoundingClientRect();
    const inBand = r.width > 0 && r.top < TITLEBAR_H;
    const edge = inBand && r.top < TRAFFIC_LIGHTS_H && r.left < TRAFFIC_LIGHTS_W;
    // Indent only past the part of the lights this row actually sits under
    // (a row beside a 44px rail needs 34px, not 78). A row too narrow to indent
    // (an icon-only rail) drops below the lights instead.
    const inset = TRAFFIC_LIGHTS_W - Math.max(0, r.left);
    const fits = r.width >= inset + 40;
    el.classList.toggle("titlebar-head", inBand);
    el.classList.toggle("titlebar-head--edge", edge && fits);
    el.classList.toggle("titlebar-head--under", edge && !fits);
    if (edge && fits) el.style.setProperty("--titlebar-edge-inset", `${inset}px`);
    else el.style.removeProperty("--titlebar-edge-inset");
  };
  // Every trigger fires at the START of a layout change; the sidebar and the
  // rails animate their width, so the row keeps sliding for a few hundred ms
  // after. Measure now and again once the motion has settled.
  let settle: ReturnType<typeof setTimeout>[] = [];
  const kick = () => {
    settle.forEach(clearTimeout);
    measure();
    settle = [400, 900].map((ms) => setTimeout(measure, ms));
  };
  kick();
  const ro = new ResizeObserver(kick);
  ro.observe(el);
  // Vertical moves (a tab bar or breadcrumb appearing above) change how much of
  // the row lies in the titlebar band; horizontal moves (a rail opening beside
  // it) change how much lies in the traffic-light corner. Neither resizes the
  // row itself, so each gets an IntersectionObserver rooted on that region —
  // rebuilt on window resize since the regions are expressed as root margins.
  let observers: IntersectionObserver[] = [];
  const watch = () => {
    observers.forEach((o) => o.disconnect());
    const threshold = Array.from({ length: 11 }, (_, i) => i / 10);
    observers = [
      `0px 0px ${TITLEBAR_H - window.innerHeight}px 0px`,
      `0px ${TRAFFIC_LIGHTS_W - window.innerWidth}px ${TITLEBAR_H - window.innerHeight}px 0px`,
    ].map((rootMargin) => {
      const io = new IntersectionObserver(kick, { rootMargin, threshold });
      io.observe(el);
      return io;
    });
  };
  watch();
  const onResize = () => { watch(); kick(); };
  window.addEventListener("resize", onResize);
  return () => {
    settle.forEach(clearTimeout);
    ro.disconnect();
    observers.forEach((o) => o.disconnect());
    window.removeEventListener("resize", onResize);
    el.classList.remove("titlebar-head", "titlebar-head--edge", "titlebar-head--under");
    el.style.removeProperty("--titlebar-edge-inset");
  };
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

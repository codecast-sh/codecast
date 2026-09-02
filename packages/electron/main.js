const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell, screen, Notification, session, powerMonitor, desktopCapturer, systemPreferences } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

app.name = "Codecast";

// Isolated profile for dev/test runs so a from-source instance can run beside
// the installed app: its own singleton lock, service-worker cache, IndexedDB,
// and localStorage. Must be set before anything reads userData paths.
if (process.env.CODECAST_USER_DATA) {
  app.setPath("userData", process.env.CODECAST_USER_DATA);
}

// Disable Chromium's trackpad/overscroll swipe-to-navigate (back/forward).
// We push a history entry per viewed conversation, so an accidental two-finger
// horizontal swipe would walk backward through that stack and "randomly" jump
// conversations. Deliberate back/forward (Cmd+[ / Cmd+], app menu) uses
// webContents.goBack()/goForward() and is unaffected. The CSS overscroll-behavior
// rule covers this too; this is the belt-and-suspenders native guard.
app.commandLine.appendSwitch("disable-features", "OverscrollHistoryNavigation");

// System audio for the meeting recorder. The display-media handler below
// answers `audio: "loopback"`; on Windows Chromium honors that natively, on
// macOS 13+ only behind these two hidden feature flags (ScreenCaptureKit
// loopback — Chromium ships the code but leaves it off until Electron 39).
// The capture itself rides screen capture, so it is gated by the Screen
// Recording permission, same as screen share.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride");
}

// Pin Chromium's download path to our userData dir so macOS TCC never
// probes ~/Documents or ~/Downloads and triggers the permission dialog.
const _ud = app.getPath("userData");
for (const dir of ["downloads", "temp"]) {
  const p = path.join(_ud, dir);
  fs.mkdirSync(p, { recursive: true });
  app.setPath(dir, p);
}

const { pickWindow, chooseLeader, RecentKeys } = require("./notificationRouter");
const {
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  normalizeCallWindowSize,
} = require("./callWindowPolicy");
const {
  mergeMeetingDetect,
  meetingAppList,
  meetingAppName,
  detectMeetingApps,
  startedApps,
  decideOffer,
} = require("./meetingDetector");
const { createOsPermissions } = require("./osPermissions");

let notificationRefs = [];

function showNativeNotification(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const notif = new Notification({ title, body, silent: false, urgency: "critical" });
  if (onClick) notif.on("click", onClick);
  notif.on("close", () => { notificationRefs = notificationRefs.filter(n => n !== notif); });
  notificationRefs.push(notif);
  notif.show();
}

const PROD_URL = "https://codecast.sh";
// Dev mode. Must be https: the http origin 301-redirects to https (nginx
// single-auth-origin fix), and http/https are separate localStorage origins
// so the Convex auth token only lives on https. Loading http here would
// redirect anyway — point straight at https to skip the round-trip.
const LOCAL_URL = "https://local.codecast.sh";
// Env is sticky across restarts: the last toggled choice is persisted in
// settings.json (see toggleEnvironment). An explicit CODECAST_URL still wins.
const BASE_URL =
  process.env.CODECAST_URL || (loadFullSettings().env === "local" ? LOCAL_URL : PROD_URL);

// local.codecast.sh resolves to 127.0.0.1 and is served with a locally
// generated mkcert dev certificate. mkcert's CA is in the macOS keychain so
// Safari/Chrome trust it, but Electron's bundled Chromium rejects it
// (ERR_CERT_AUTHORITY_INVALID), which makes dev mode fail to load entirely.
// We trust the cert for this one loopback host only (see the verify proc in
// app.whenReady) — production validation is left fully intact.
const LOCAL_DEV_HOST = "local.codecast.sh";

const { DEFAULT_SHORTCUTS, mergeShortcuts, diffOverrides } = require("./shortcutSettings");

let mainWindow = null;
let paletteWindow = null;
// Whether Codecast's own window was frontmost when the palette was summoned.
// Decides where Enter's fire-and-forget hand-back lands (see compose-submit).
let paletteSummonedOverSelf = false;
let tray = null;
let deepLinkUrl = null;
let currentBaseUrl = BASE_URL;

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadFullSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function loadSettings() {
  return mergeShortcuts(loadFullSettings().shortcuts);
}

function updateSettings(patch) {
  const existing = loadFullSettings();
  fs.writeFileSync(getSettingsPath(), JSON.stringify({ ...existing, ...patch }, null, 2));
}

function saveSettings(shortcuts) {
  updateSettings({ shortcuts: diffOverrides(shortcuts) });
}


// Single instance lock — clear stale locks from crashed/updated processes
let gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  const userDataPath = app.getPath("userData");
  const lockPath = path.join(userDataPath, "SingletonLock");
  try {
    const target = fs.readlinkSync(lockPath);
    const pid = parseInt(target.split("-").pop(), 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive) {
      for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try { fs.unlinkSync(path.join(userDataPath, f)); } catch {}
      }
      gotLock = app.requestSingleInstanceLock();
    }
  } catch {}
  if (!gotLock) app.quit();
}
if (gotLock) {
  app.on("second-instance", (_e, argv) => {
    const url = argv.find((a) => a.startsWith("codecast://"));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Deep link protocol. Packaged builds only: a from-source run must NOT claim
// the scheme — on macOS every node_modules Electron.app shares the bundle id
// com.github.Electron, so a dev run registering codecast:// rebinds the
// user's links to whichever bare Electron shell Launch Services finds first
// (observed: links opening footage-app's Electron welcome screen). Set
// CODECAST_CLAIM_PROTOCOL=1 to opt a dev run in deliberately.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient("codecast");
} else if (process.env.CODECAST_CLAIM_PROTOCOL) {
  app.setAsDefaultProtocolClient("codecast", process.execPath, [app.getAppPath()]);
}

app.on("open-url", (e, url) => {
  e.preventDefault();
  if (mainWindow) {
    handleDeepLink(url);
  } else {
    deepLinkUrl = url;
  }
});

function handleDeepLink(url) {
  if (!mainWindow) { deepLinkUrl = url; return; }
  mainWindow.show();
  mainWindow.focus();
  // While the main frame is still loading, the renderer (and the preload buffer
  // that catches early sends) is about to be torn down and rebuilt — sending
  // now would land in a soon-to-be-replaced context. Hold it for the page's
  // did-finish-load, which fires once the new renderer (and its buffer) is live.
  if (mainWindow.webContents.isLoadingMainFrame()) {
    deepLinkUrl = url;
  } else {
    mainWindow.webContents.send("deep-link", url);
  }
}

function getAutoZoomFactor() {
  return 1.0;
}

function createWindow() {
  const zoom = getAutoZoomFactor();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`],
      // Keep the Convex live-query WebSocket alive when the window is
      // hidden or unfocused. Default-on throttling can pause subscription
      // delivery in the renderer, leaving the inbox stale until refocus.
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
    backgroundColor: "#002b36",
  });

  // Retry/watchdog for cold-start hangs: if the initial nav fails or the
  // page stalls before reaching the app shell, reload automatically instead
  // of leaving the user on a frozen splash that only cmd-r recovers.
  let stallTimer = null;
  let loadAttempts = 0;
  const MAX_LOAD_ATTEMPTS = 5;
  const STALL_MS = 10_000;

  function armStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (loadAttempts >= MAX_LOAD_ATTEMPTS) return;
      loadAttempts++;
      mainWindow.webContents.reloadIgnoringCache();
      armStallTimer();
    }, STALL_MS);
  }

  function startLoad() {
    loadAttempts++;
    armStallTimer();
    mainWindow.loadURL(currentBaseUrl);
  }

  mainWindow.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 is ABORTED (intentional nav cancel) — don't retry on that.
    if (errorCode === -3) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (loadAttempts >= MAX_LOAD_ATTEMPTS) return;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      startLoad();
    }, 500);
  });

  startLoad();

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    clearTimeout(stallTimer);
    stallTimer = null;
    loadAttempts = 0;
    mainWindow.webContents.setZoomFactor(getAutoZoomFactor());
    mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
    // The first breakout window boots in the background once the main window
    // is up, so "open in new window" is a navigation rather than a cold load.
    warmSpareTabWindow();
    // Sticky env can boot us into local mode — mark the title the same way
    // toggleEnvironment does so it's never mistaken for prod.
    if (currentBaseUrl === LOCAL_URL) {
      mainWindow.webContents.executeJavaScript(
        "document.title = '[LOCAL] ' + document.title"
      );
    }
    // The page is fully loaded, so the preload's deep-link listener and replay
    // buffer are live — deliver any link that arrived during boot or a reload.
    // did-finish-load only fires on a COMPLETE load, so if the first attempt
    // failed/stalled the link stays pending and rides the retry's load instead.
    if (deepLinkUrl) {
      const url = deepLinkUrl;
      deepLinkUrl = null;
      mainWindow.webContents.send("deep-link", url);
    }
    // Replay the latest update status so a freshly-loaded (or reloaded) renderer
    // doesn't miss a download that progressed/finished before it mounted.
    if (lastUpdateStatus) {
      mainWindow.webContents.send("update-status", lastUpdateStatus);
    }
    // Tabs handed back by detached windows while the main window was closed
    // or still loading — adopt them now that the renderer can hear us.
    if (pendingAdoptPaths.length) {
      const paths = pendingAdoptPaths;
      pendingAdoptPaths = [];
      for (const p of paths) mainWindow.webContents.send("adopt-tab", p);
    }
  });


  // Every window.open/target=_blank goes to the default browser — the app is a
  // single window that navigates in place, so a same-origin link here (e.g. a
  // published artifact at codecast.sh/a/…) still means "open outside the app".
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    clearTimeout(stallTimer);
    mainWindow = null;
    broadcastWindowRole();
  });
  broadcastWindowRole();
}

// ---------------------------------------------------------------------------
// Detached tab windows: a dashboard tab broken out into its own OS window.
// The window loads the tab's path directly and its preload carries a
// --tab-window flag, which the renderer reads to disable its tab shell and
// any writes to shared tab/layout state. "Attach" reverses it: the sender
// window closes and the main window adopts the path back as a tab.
// ---------------------------------------------------------------------------

const tabWindows = new Set();
let pendingAdoptPaths = [];

// Only app-internal paths may ride the detach/attach IPC — a stray absolute
// URL would otherwise turn a tab window into a browser for arbitrary sites.
function sanitizeTabPath(navPath) {
  if (typeof navPath !== "string") return null;
  if (!navPath.startsWith("/") || navPath.startsWith("//")) return null;
  return navPath;
}

// The window itself, hidden and unpositioned. Both the cold path and the warm
// spare build one of these; only what gets loaded into it differs.
function buildTabWindow() {
  const zoom = getAutoZoomFactor();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`, "--tab-window"],
      // Same as the main window: keep live-query WebSockets delivering while
      // the window sits unfocused behind others.
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
    backgroundColor: "#002b36",
  });
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(getAutoZoomFactor());
    win.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
  });
  // Same rule as every window: new-window links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    tabWindows.delete(win);
    if (spareTabWindow === win) spareTabWindow = null;
    broadcastWindowRole();
  });
  return win;
}

// ---------------------------------------------------------------------------
// The warm spare. A detached window used to boot the whole web app from a cold
// loadURL — bundle, store hydration, Convex reconnect — so "open in new window"
// took seconds. Now one hidden tab window sits booted at /inbox, and a detach
// hands it the route through the same in-app navigation the tray and
// notifications use (a pushState, not a load), then shows it. A fresh spare
// warms up behind it. The spare is NOT in `tabWindows` until it is claimed, so
// it never counts as an app window for focus, leadership or banner routing.
// ---------------------------------------------------------------------------

const SPARE_WARM_DELAY_MS = 6000;
let spareTabWindow = null;
let spareTabReady = false;
let spareTabTimer = null;

function warmSpareTabWindow(delayMs = SPARE_WARM_DELAY_MS) {
  if (spareTabTimer) return;
  spareTabTimer = setTimeout(() => {
    spareTabTimer = null;
    if (appIsQuitting) return;
    if (spareTabWindow && !spareTabWindow.isDestroyed()) return;
    const win = buildTabWindow();
    spareTabWindow = win;
    spareTabReady = false;
    win.webContents.once("did-finish-load", () => {
      if (spareTabWindow === win) spareTabReady = true;
    });
    win.loadURL(`${currentBaseUrl}/inbox`);
  }, delayMs);
}

// Throw the spare away (environment switch: it is booted on the wrong origin).
function dropSpareTabWindow() {
  if (spareTabTimer) {
    clearTimeout(spareTabTimer);
    spareTabTimer = null;
  }
  if (spareTabWindow && !spareTabWindow.isDestroyed()) spareTabWindow.destroy();
  spareTabWindow = null;
  spareTabReady = false;
}

function claimSpareTabWindow() {
  const win = spareTabWindow;
  if (!win || win.isDestroyed() || !spareTabReady) return null;
  spareTabWindow = null;
  spareTabReady = false;
  return win;
}

function createTabWindow(navPath) {
  // Cascade from the main window so a breakout never opens exactly on top.
  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const spare = claimSpareTabWindow();
  const win = spare || buildTabWindow();
  if (base) win.setPosition(base.x + 40 + tabWindows.size * 24, base.y + 40 + tabWindows.size * 24);
  tabWindows.add(win);

  if (spare) {
    // Navigate first, show once the new route has painted, so the window never
    // flashes the inbox it was parked on. The URL flips before React commits
    // the route; the title flips with the commit, so wait for that (capped, in
    // case the route keeps the title) and then for a frame to paint.
    win.webContents
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify(navPath)} }));` +
          "new Promise((done) => { const t0 = document.title, start = Date.now();" +
          "  const tick = () => (document.title !== t0 || Date.now() - start > 400)" +
          "    ? requestAnimationFrame(() => requestAnimationFrame(done)) : setTimeout(tick, 16);" +
          "  tick(); })"
      )
      .catch(() => {})
      .then(() => {
        if (!win.isDestroyed()) win.show();
      });
  } else {
    win.loadURL(`${currentBaseUrl}${navPath}`);
    win.once("ready-to-show", () => win.show());
  }
  broadcastWindowRole();
  // The next breakout should be instant too.
  warmSpareTabWindow();
  return win;
}

ipcMain.handle("detach-tab", (_e, navPath) => {
  const clean = sanitizeTabPath(navPath);
  if (clean) createTabWindow(clean);
});

ipcMain.handle("attach-tab", (e, navPath) => {
  const clean = sanitizeTabPath(navPath);
  if (!clean) return;
  const sender = BrowserWindow.fromWebContents(e.sender);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("adopt-tab", clean);
    mainWindow.show();
    mainWindow.focus();
  } else {
    // Main window is gone (macOS keeps the app alive) — recreate it and let
    // its did-finish-load flush deliver the adoption.
    pendingAdoptPaths.push(clean);
    createWindow();
  }
  if (sender && tabWindows.has(sender)) sender.close();
});

// ---------------------------------------------------------------------------
// The people window: a compact floating buddy list (route /people) carrying the
// roster, status and calling. Singleton — one per app, focused rather than
// duplicated. It is the phone: while it exists it is the notification leader
// for sounds and every call/walkie banner lands in it (notificationRouter.js).
// Its size, position and always-on-top pin persist across launches; the pin is
// the only window control the renderer may drive, and only from this window.
// ---------------------------------------------------------------------------

const PEOPLE_PATH = "/people";
// The minimums are a STRIP: one row of faces beside the traffic lights (see
// components/people/peopleDensity.ts — the renderer picks its shape from the
// box it is given). A buddy list pinned above other apps earns its place by
// costing almost none of the screen.
const PEOPLE_SIZE = { width: 320, height: 640, minWidth: 240, minHeight: 56 };

let peopleWindow = null;
let peopleBoundsTimer = null;

function loadPeopleState() {
  const saved = loadFullSettings().peopleWindow;
  return saved && typeof saved === "object" ? saved : {};
}

function updatePeopleState(patch) {
  updateSettings({ peopleWindow: { ...loadPeopleState(), ...patch } });
}

// A saved rectangle only helps if it is still on screen: displays get unplugged
// and resolutions change. getDisplayMatching gives us the display it overlaps
// most (the nearest one when it overlaps none), and we clamp into that display's
// work area — so a window saved on a monitor that is gone reopens on a real one.
function clampToVisibleDisplay(saved, size = PEOPLE_SIZE) {
  if (!saved || typeof saved.x !== "number" || typeof saved.y !== "number") return null;
  const area = screen.getDisplayMatching({
    x: saved.x,
    y: saved.y,
    width: Math.round(saved.width) || size.width,
    height: Math.round(saved.height) || size.height,
  }).workArea;
  const width = Math.min(Math.max(size.minWidth, Math.round(saved.width) || size.width), area.width);
  const height = Math.min(Math.max(size.minHeight, Math.round(saved.height) || size.height), area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(Math.round(saved.x), area.x), area.x + area.width - width),
    y: Math.min(Math.max(Math.round(saved.y), area.y), area.y + area.height - height),
  };
}

function savePeopleBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  updatePeopleState({ bounds: win.getBounds() });
}

function createPeopleWindow() {
  if (peopleWindow && !peopleWindow.isDestroyed()) {
    peopleWindow.show();
    peopleWindow.focus();
    return peopleWindow;
  }
  const state = loadPeopleState();
  const bounds = clampToVisibleDisplay(state.bounds);
  const zoom = getAutoZoomFactor();
  const win = new BrowserWindow({
    width: PEOPLE_SIZE.width,
    height: PEOPLE_SIZE.height,
    ...(bounds || {}),
    minWidth: PEOPLE_SIZE.minWidth,
    minHeight: PEOPLE_SIZE.minHeight,
    // Same inset lights as every other window. The panel DECLARES the inset
    // (desktopHeaderClass / --titlebar-inset) rather than measuring it — its
    // top row is at the window's corner by construction — and draws its own
    // drag region from the same class.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    // Restored from the last session: a pinned buddy list stays pinned.
    alwaysOnTop: state.alwaysOnTop === true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`, "--people-window"],
      // It is the phone: rings, presence and walkie audio must keep arriving
      // while it sits unfocused beside another app.
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
    backgroundColor: "#002b36",
  });
  peopleWindow = win;

  win.loadURL(`${currentBaseUrl}${PEOPLE_PATH}`);
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(getAutoZoomFactor());
    win.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
  });
  // Same rule as every window: new-window links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Dragging and resizing fire continuously; save once the gesture settles.
  const rememberBounds = () => {
    clearTimeout(peopleBoundsTimer);
    peopleBoundsTimer = setTimeout(() => savePeopleBounds(win), 400);
  };
  win.on("move", rememberBounds);
  win.on("resize", rememberBounds);
  win.on("close", () => {
    clearTimeout(peopleBoundsTimer);
    savePeopleBounds(win);
  });
  win.on("closed", () => {
    if (peopleWindow === win) peopleWindow = null;
    broadcastWindowRole();
  });
  broadcastWindowRole();
  return win;
}

ipcMain.handle("open-people-window", () => {
  createPeopleWindow();
});

// The pin. Only the people window may float above other apps — any other
// renderer asking is answered with what it actually is (false), never granted.
ipcMain.handle("set-always-on-top", (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win !== peopleWindow) return false;
  const pinned = on === true;
  win.setAlwaysOnTop(pinned);
  updatePeopleState({ alwaysOnTop: pinned });
  return pinned;
});

ipcMain.handle("get-always-on-top", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return !!win && !win.isDestroyed() && win.isAlwaysOnTop();
});

// ---------------------------------------------------------------------------
// The call window: a huddle in a window of its own (route /call-panel), in
// four sizes — the stage, a row of face circles, one speaker circle, or that
// circle shrunk to the size of a menu bar icon.
//
// A REAL window. The founder's screenshot was a call stage living in a Chrome
// popup: no app chrome, the OS treating it as a browser, and a microphone
// permission attached to a window nobody recognizes. This is the window that
// makes that outcome impossible, and the web side refuses to fall back to
// window.open for a call at all.
//
// Singleton, because the product allows ONE huddle at a time (calls.joinRoom
// enforces it server-side): opening the panel onto another room moves the
// window that exists rather than making a second.
//
// ── Why it is born see-through, whatever size it is in ────────────────────
// `transparent` and `frame` are BrowserWindow CONSTRUCTION options; Electron
// has no runtime switch for either. The circle sizes need both, so the window
// is born with both and the STAGE paints its own card inside the glass. That
// is the whole reason there is one window here and not two: a call changing
// shape must never be a call changing windows, because changing windows means
// re-joining the room, and a person switching from the stage to a circle is
// not asking for their audio to be re-established.
//
// It also means this window has no title bar and no traffic lights. The stage's
// own header row is the drag surface, and its own button closes the window.
//
// ── The handoff, main window ⇄ this one ───────────────────────────────────
// The shell does not move the call; it only opens and closes the window. The
// call moves because whichever window is showing /call-panel JOINS the room,
// and LiveKit signs every window of one person with the same identity — so the
// new window's join evicts the old window's participant, in that order. This
// end of it therefore has exactly one job on the way out: tell the main window
// the room is coming back.
//
// That message is sent on 'close', NOT on 'closed'. The panel is still
// connected at that moment, so the main window's rejoin is what evicts it, and
// the audio never has a hole in it. Waiting for the window to be destroyed
// would open a real gap for no reason.
//
// ── What a see-through size needs from the shell ──────────────────────────
// Three things an ordinary window never asks for, all runtime-settable, all
// applied only in the circle sizes:
//
//   ignore mouse events  The window is a rectangle, the product is a few
//                        circles. It ignores the mouse so a click lands in
//                        whatever is underneath, and the renderer — the only
//                        side that knows where the circles are — turns that off
//                        while the pointer is over one.
//   content size         It is sized to its circles, which changes with the
//                        size, the tier and who is in the room.
//   drag                 Held on a circle, the window follows the cursor. Not a
//                        `-webkit-app-region: drag` region: over one of those
//                        the window manager takes the mouse events, so the
//                        renderer would never learn the pointer had left and
//                        the window would stay stuck taking clicks that belong
//                        to the application underneath. (The STAGE does use a
//                        drag region, because it is not click-through, so
//                        nothing is fighting for those events there.)
// ---------------------------------------------------------------------------

const CALL_PANEL_PATH = "/call-panel";
const CALL_PANEL_SIZE = { width: 960, height: 640, minWidth: 520, minHeight: 380 };
// What a circle size is born as: about one speaker circle plus the room its
// ring needs. The renderer reports the true size a frame later
// (set-call-window-content-size); this only keeps the first frame from being a
// full-screen sheet of invisible glass.
const CALL_CIRCLES_SIZE = { width: 112, height: 112 };

let callWindow = null;
let callPlaceTimer = null;
// What the panel says it is hosting: { room, mic, camera, scribe }. This IS the
// handback payload — the main window has to arrive in the state the person was
// already in, or closing the panel mutes them mid-sentence.
let callWindowState = null;
// The panel declared the call OVER (its hang-up button). Closing then hands
// nothing back. Silence means the opposite: a window closed without a hang-up
// is a call still going, so the safe reading is to hand it back.
let callWindowEnded = false;
// Which of the three sizes the window is in. Remembered per machine, so the
// next popout comes back the shape the person left it.
let callWindowSize = "panel";
// The app is going away. Every window gets `close` during a quit, including
// this one, and a handback then would raise the main window on the way out and
// ask it to join a room the process is about to stop existing for.
let appIsQuitting = false;
app.on("before-quit", () => {
  appIsQuitting = true;
});

function loadCallPanelState() {
  const saved = loadFullSettings().callPanelWindow;
  return saved && typeof saved === "object" ? saved : {};
}

// The stage's bounds and the circles' position are remembered SEPARATELY. They
// are the same window, but they are not the same place: the stage is a card you
// put in the middle of the screen and the circles are a strip you tuck in a
// corner, and saving one over the other would drag each to where the other was
// last left.
function saveCallPanelBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  if (callWindowPlacementKey(callWindowSize) !== "bounds") return;
  updateSettings({ callPanelWindow: { ...loadCallPanelState(), bounds: win.getBounds() } });
}

function saveCallCirclesPosition(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  if (callWindowPlacementKey(callWindowSize) !== "circles") return;
  const [x, y] = win.getPosition();
  updateSettings({ callPanelWindow: { ...loadCallPanelState(), circles: { x, y } } });
}

function rememberCallWindowPlace(win) {
  saveCallPanelBounds(win);
  saveCallCirclesPosition(win);
}

function savedCallWindowSize() {
  return normalizeCallWindowSize(loadCallPanelState().size);
}

function callPanelUrl(roomKey, opts) {
  const q = new URLSearchParams({ room: String(roomKey) });
  if (opts && opts.mic) q.set("mic", "1");
  if (opts && opts.camera) q.set("cam", "1");
  if (opts && opts.scribe) q.set("scribe", "1");
  // The size the window is opening in, so the renderer's first paint is the
  // right shape rather than a stage that snaps to circles a frame later.
  if (callWindowSize !== "panel") q.set("size", callWindowSize);
  return `${currentBaseUrl}${CALL_PANEL_PATH}?${q.toString()}`;
}

// Where the circles sit the first time: the top-right of the work area, out of
// the way of most windows' content, indented enough to clear a menu bar.
function defaultCirclesPosition(width) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(area.x + area.width - width - 28), y: Math.round(area.y + 28) };
}

function circlesPosition(size) {
  const saved = loadCallPanelState().circles;
  if (!saved || typeof saved.x !== "number" || typeof saved.y !== "number") {
    return defaultCirclesPosition(size.width);
  }
  // A display that is gone (an unplugged monitor) would otherwise put the
  // window somewhere nobody can see, and in the circle sizes it has no title
  // bar and no taskbar entry to recover it from.
  const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, ...size }).workArea;
  return {
    x: Math.min(Math.max(Math.round(saved.x), area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(Math.round(saved.y), area.y), area.y + area.height - size.height),
  };
}

/**
 * Put the window into a size: where it sits, how big it is, and what kind of
 * window it is while it is there.
 *
 * The kind comes from `callWindowChrome` rather than from an `if` here, because
 * the three flags have to move together — an always-on-top window that still
 * takes every click is a pane floating over somebody's work, and a
 * click-through window that is NOT on top is a window you cannot reach at all.
 */
function applyCallWindowSize(win, size) {
  if (!win || win.isDestroyed()) return;
  const chrome = callWindowChrome(size);
  // Resizable FIRST and restored last: Electron refuses setBounds/setSize on a
  // window that is not resizable, so the moves below happen while the flag is
  // up whatever the size asks for.
  win.setResizable(true);
  if (size === "panel") {
    const bounds = clampToVisibleDisplay(loadCallPanelState().bounds, CALL_PANEL_SIZE);
    win.setMinimumSize(CALL_PANEL_SIZE.minWidth, CALL_PANEL_SIZE.minHeight);
    win.setBounds(
      bounds || {
        ...defaultPanelBounds(),
        width: CALL_PANEL_SIZE.width,
        height: CALL_PANEL_SIZE.height,
      },
    );
  } else {
    // No minimum, or a 520px floor would stop the window ever being the size of
    // one 96px circle.
    win.setMinimumSize(1, 1);
    win.setContentSize(CALL_CIRCLES_SIZE.width, CALL_CIRCLES_SIZE.height);
    const [width, height] = win.getSize();
    const pos = circlesPosition({ width, height });
    win.setPosition(pos.x, pos.y);
  }
  win.setResizable(chrome.resizable);
  win.setAlwaysOnTop(chrome.alwaysOnTop, "floating");
  // Follow the person between desktops and stay visible over a full-screen app
  // — the two places a minimized call is most needed and least reachable.
  win.setVisibleOnAllWorkspaces(chrome.visibleOnAllWorkspaces, { visibleOnFullScreen: true });
  // `forward: true` is what keeps the renderer receiving mouse MOVES while it
  // ignores clicks — without it the window would go deaf the moment the pointer
  // left a circle and could never learn that it came back.
  win.setIgnoreMouseEvents(chrome.clickThrough, { forward: true });
  if (!chrome.clickThrough) stopCallWindowDrag();
  // The idle faces overlay yields to the call's circles and returns when the
  // call grows back to the stage — the two share one spot on screen.
  syncFacesOverlayYield();
}

function defaultPanelBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - CALL_PANEL_SIZE.width) / 2),
    y: Math.round(area.y + (area.height - CALL_PANEL_SIZE.height) / 2),
  };
}

function createCallWindow(roomKey, opts) {
  if (!roomKey || typeof roomKey !== "string") return null;
  callWindowEnded = false;
  if (callWindow && !callWindow.isDestroyed()) {
    // Already open. On a DIFFERENT room, point it at the new one — one call at
    // a time means one panel, and the person asked for this room.
    if (!callWindowState || callWindowState.room !== roomKey) {
      callWindow.loadURL(callPanelUrl(roomKey, opts));
    }
    // An asked-for size reshapes the window that exists, the same way the
    // renderer's own size buttons do.
    if (opts && opts.size) {
      const next = normalizeCallWindowSize(opts.size);
      if (next !== callWindowSize) {
        rememberCallWindowPlace(callWindow);
        callWindowSize = next;
        updateSettings({ callPanelWindow: { ...loadCallPanelState(), size: next } });
        applyCallWindowSize(callWindow, next);
      }
    }
    // showInactive in the circle sizes: they are a glance you keep beside your
    // work, and one that stole the keyboard every time it appeared would be
    // worse than no circle at all.
    if (callWindowSize === "panel") {
      callWindow.show();
      callWindow.focus();
    } else {
      callWindow.showInactive();
    }
    return callWindow;
  }
  // The size the person last left it in — unless the opener asked for one
  // (the walkie card's "Float over your work" wants circles, not a stage).
  // Read before the URL is built, because the renderer is told which shape it
  // is opening in.
  callWindowSize = opts && opts.size ? normalizeCallWindowSize(opts.size) : savedCallWindowSize();
  if (opts && opts.size) updateSettings({ callPanelWindow: { ...loadCallPanelState(), size: callWindowSize } });
  const bounds = clampToVisibleDisplay(loadCallPanelState().bounds, CALL_PANEL_SIZE);
  const zoom = getAutoZoomFactor();
  const win = new BrowserWindow({
    width: CALL_PANEL_SIZE.width,
    height: CALL_PANEL_SIZE.height,
    ...(bounds || {}),
    minWidth: CALL_PANEL_SIZE.minWidth,
    minHeight: CALL_PANEL_SIZE.minHeight,
    // No chrome, in any size. The circle sizes need a see-through frameless
    // window and neither option can be changed after construction, so the stage
    // is a card the renderer paints inside the same glass: rounded corners of
    // its own, its header row as the drag surface, its own close button.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // The OS shadow is a rectangle around the whole window. Around a rounded
    // card it is a visible seam, and around a circle it is a grey box floating
    // over somebody's work.
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`, "--call-panel-window"],
      // It holds the call. Throttling this window would throttle the media —
      // and in the circle sizes it is usually behind another window, since
      // being behind other windows is what those sizes are for.
      backgroundThrottling: false,
      // Face tracking needs the Shape Detection API's FaceDetector, and
      // Chromium does not expose it by default any more — measured on Chrome
      // 151: absent without a flag, present with `--enable-blink-features=
      // FaceDetector` (the name is the interface's, not "ShapeDetection",
      // which does nothing). Enabled HERE rather than app-wide, because this is
      // the one window that draws face circles: a process-wide switch, or the
      // experimental-web-platform-features flag that also turns it on, would
      // hand every window in the app a pile of unfinished APIs.
      //
      // Without it nothing breaks — the circles show a center crop, which is a
      // fine picture of somebody at their desk; it just does not follow them.
      enableBlinkFeatures: "FaceDetector",
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
  });
  callWindow = win;
  callWindowState = {
    room: roomKey,
    mic: !!(opts && opts.mic),
    camera: !!(opts && opts.camera),
    scribe: !!(opts && opts.scribe),
  };

  applyCallWindowSize(win, callWindowSize);
  win.loadURL(callPanelUrl(roomKey, opts));
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (callWindowSize === "panel") win.show();
    else win.showInactive();
  });
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(getAutoZoomFactor());
    win.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
  });
  // Same rule as every window: new-window links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Debounced: a drag moves this window at the cursor's rate, and writing the
  // settings file on every one of those would be sixty disk writes a second.
  // Both savers run and each ignores the sizes it does not own, so the size the
  // window is actually in is the one that gets written.
  const remember = () => {
    clearTimeout(callPlaceTimer);
    callPlaceTimer = setTimeout(() => rememberCallWindowPlace(win), 400);
  };
  win.on("move", remember);
  win.on("resize", remember);
  win.on("close", (e) => {
    clearTimeout(callPlaceTimer);
    stopCallWindowDrag();
    rememberCallWindowPlace(win);
    // A live huddle is a window of its own. Closing it hides, like the
    // palette — the microphone stays, the main window does not grow a card
    // trapped in its edges. Hang-up and quit actually destroy it.
    if (
      shouldHideCallWindow({
        ended: callWindowEnded,
        quitting: appIsQuitting,
      })
    ) {
      e.preventDefault();
      win.hide();
      syncFacesOverlayYield();
      broadcastWindowRole();
      return;
    }
    handBackCall({ ended: callWindowEnded });
  });
  win.on("closed", () => {
    if (callWindow === win) {
      callWindow = null;
      callWindowState = null;
      callWindowEnded = false;
    }
    // The call is gone; the idle faces overlay it displaced comes back.
    syncFacesOverlayYield();
    broadcastWindowRole();
  });
  broadcastWindowRole();
  return win;
}

// Tell the main window the call is coming back. Sent while the leaving window
// is still connected, so the main window's join is what ends its participation
// and the two never both let go at once.
//
// `ended` is the leaving window's own account of why it closed, and it is the
// only thing that stops a handback other than the app quitting: with one call
// window there is nowhere else for a live call to be.
function handBackCall({ ended } = {}) {
  const state = callWindowState;
  const hand = shouldHandBackCall({
    ended: !!ended,
    quitting: appIsQuitting,
    room: (state && state.room) || null,
  });
  if (!hand) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("call-panel-handback", {
    room: state.room,
    mic: !!state.mic,
    camera: !!state.camera,
    scribe: !!state.scribe,
  });
  mainWindow.show();
}

// Only the call window may drive its own size, click-through and drag, and only
// while it exists — verified by sender identity, never by the claim.
function senderIsCallWindow(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && !win.isDestroyed() && win === callWindow ? win : null;
}

// ── The see-through switches, shared by the floating circle windows ────────
//
// Two windows draw circles over the person's work: the minimized call and the
// idle faces overlay. Both need the same three runtime switches — lift
// click-through while the pointer is over a circle, stay the size of their
// circles, follow a held cursor — and the switches must behave identically or
// the two surfaces drift into windows that feel different for no reason. Each
// window registers its own channels; the logic is this one implementation.
function registerSeeThroughIpc(prefix, resolveSender, opts = {}) {
  const mayInteract = opts.mayInteract || (() => true);
  const mayResize = opts.mayResize || (() => true);
  const getWindow = opts.getWindow;
  let dragTimer = null;
  const stopDrag = () => {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
  };

  // Click-through, lifted while the renderer says the pointer is over a
  // circle. Only the click-through states have anything to lift: the call
  // stage takes every click by construction, and letting a renderer turn that
  // off would make the panel unclickable with no way back.
  ipcMain.on(`set-${prefix}-interactive`, (e, on) => {
    const win = resolveSender(e);
    if (!win || !mayInteract()) return;
    win.setIgnoreMouseEvents(on !== true, { forward: true });
  });

  // The circles are sized to their contents: the renderer measures them and
  // says how big the window has to be.
  ipcMain.on(`set-${prefix}-content-size`, (e, size) => {
    const win = resolveSender(e);
    if (!win || !mayResize()) return;
    if (!size || typeof size !== "object") return;
    const width = Math.round(Number(size.width));
    const height = Math.round(Number(size.height));
    if (!(width > 0) || !(height > 0) || width > 4000 || height > 4000) return;
    // The renderer measures in CSS pixels and the window is sized in device-
    // independent ones, and the two come apart the moment somebody zooms the
    // page: at 1.5x a 112px row of circles needs a 168px window, and a window
    // sized to 112 would clip its own faces.
    const zoom = win.webContents.getZoomFactor();
    const [w, h] = [Math.round(width * zoom), Math.round(height * zoom)];
    const [curW, curH] = win.getContentSize();
    if (curW === w && curH === h) return;
    // A non-resizable window refuses setContentSize; lift the flag for the
    // call and put it straight back, so the person still cannot drag an edge.
    win.setResizable(true);
    win.setContentSize(w, h);
    win.setResizable(false);
    // WIDTH growth keeps the row's centre fixed — the horizontal twin of the
    // circles' top pinning in faces.css. The circles are drawn centred, so a
    // top-left-anchored widen (hover adding a chrome wider than one face)
    // would slide every circle away from the pointer that caused it.
    // Math.trunc, not round: a hover's grow and shrink must cancel exactly at
    // any zoom, or the window walks a pixel sideways per hover cycle. Height
    // stays top-anchored — growth is downward, and the circles do not move.
    //
    // Then the display clamp. The window was placed while it was a small
    // seed — a row that grew wider than the space to the screen edge would
    // hang off it, chrome and all, with no title bar to recover it by.
    // Position wins over size when the display is smaller than the row: the
    // left edge stays reachable and the far side overflows, same rule as
    // clampCorner on the web side.
    const [x, y] = win.getPosition();
    const cx = x - Math.trunc((w - curW) / 2);
    const area = screen.getDisplayMatching({ x: cx, y, width: w, height: h }).workArea;
    const nx = Math.max(area.x, Math.min(cx, area.x + area.width - w));
    const ny = Math.max(area.y, Math.min(y, area.y + area.height - h));
    if (nx !== x || ny !== y) win.setPosition(nx, ny);
  });

  // Held on a circle, the window follows the cursor. Not a
  // `-webkit-app-region: drag` region: over one of those the window manager
  // takes the mouse events, so the renderer would never learn the pointer had
  // left and the window would stay stuck taking clicks that belong to the
  // application underneath.
  ipcMain.on(`set-${prefix}-dragging`, (e, on) => {
    const win = resolveSender(e);
    if (!win) return;
    stopDrag();
    if (!on || !mayInteract()) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const offset = { x: x - cursor.x, y: y - cursor.y };
    // The shell follows the cursor rather than the renderer sending a message
    // per mouse move: one timer instead of a hundred IPC hops a second, and it
    // keeps moving smoothly even while the renderer is busy drawing video.
    // The renderer ends the drag on pointer up. A renderer that died mid-drag
    // never will, and a window silently following the cursor around the screen
    // has no way out short of closing it — so the drag also expires on its
    // own. Nobody holds a window for half a minute.
    const until = Date.now() + 30_000;
    dragTimer = setInterval(() => {
      const live = getWindow ? getWindow() : win;
      if (!live || live.isDestroyed() || live !== win || Date.now() > until) return stopDrag();
      const p = screen.getCursorScreenPoint();
      live.setPosition(p.x + offset.x, p.y + offset.y);
    }, 16);
  });

  return { stopDrag };
}

const { stopDrag: stopCallWindowDrag } = registerSeeThroughIpc("call-window", senderIsCallWindow, {
  // Only the click-through sizes have anything to lift or drag; the stage
  // drags by its own header row and takes every click by construction.
  mayInteract: () => callWindowChrome(callWindowSize).clickThrough,
  // Resizing is refused in the panel size, where the person's own bounds are
  // the answer and a renderer resizing the window under them would be the
  // window fighting the hand on its edge.
  mayResize: () => callWindowSize !== "panel",
  getWindow: () => callWindow,
});

ipcMain.handle("open-call-panel", (_e, roomKey, opts) => {
  createCallWindow(roomKey, opts && typeof opts === "object" ? opts : {});
});

// Only the panel may close the panel, and only it can say whether the call
// ended — verified by sender identity, never by the renderer's claim.
ipcMain.handle("close-call-panel", (e, opts) => {
  const win = senderIsCallWindow(e);
  if (!win) return false;
  callWindowEnded = !!(opts && opts.ended);
  win.close();
  return true;
});

// Any window may raise the huddle: the elsewhere pill, a second huddle
// click. The call already lives here; this only makes the window visible.
ipcMain.handle("show-call-panel", () => {
  if (!callWindow || callWindow.isDestroyed()) return false;
  if (callWindowSize === "panel") {
    callWindow.show();
    callWindow.focus();
  } else {
    callWindow.showInactive();
  }
  return true;
});

ipcMain.on("report-call-panel-state", (e, state) => {
  if (!senderIsCallWindow(e)) return;
  if (!state || typeof state !== "object") return;
  callWindowState = {
    room: typeof state.room === "string" ? state.room : null,
    mic: state.mic === true,
    camera: state.camera === true,
    scribe: state.scribe === true,
  };
});

// The size change. The window keeps its media across it — that is the whole
// point of one window with three sizes — so this only moves and reshapes it.
ipcMain.handle("set-call-window-size", (e, size) => {
  const win = senderIsCallWindow(e);
  if (!win) return null;
  const next = normalizeCallWindowSize(size);
  if (next === callWindowSize) return next;
  // Remember where the size being LEFT was, before the window moves.
  rememberCallWindowPlace(win);
  callWindowSize = next;
  updateSettings({ callPanelWindow: { ...loadCallPanelState(), size: next } });
  applyCallWindowSize(win, next);
  return next;
});

ipcMain.handle("get-call-window-size", (e) => (senderIsCallWindow(e) ? callWindowSize : null));

// ---------------------------------------------------------------------------
// The faces overlay: the team as circles floating over the work (route
// /faces), when there is no call. Born see-through, frameless, always on top
// and click-through, exactly like the call window's circle sizes — the same
// spot on screen doing the same job, with photos where the call puts video.
//
// ONE FLOATING THING AT ONE SPOT. The overlay shares the call circles' saved
// position (callPanelWindow.circles): dragging either one moves where both
// live, so a call starting reads as the photos turning into video rather than
// a second thing appearing. And while the call window is in a circle size the
// overlay YIELDS — hidden, not closed — and returns when the call ends or
// grows back to the stage.
//
// Open state persists: an overlay somebody keeps over their work comes back on
// the next launch. Hiding for a call never touches that flag.
// ---------------------------------------------------------------------------

const FACES_PATH = "/faces";
// What the overlay is born as; the renderer reports the true size a frame
// later, same as the call circles. This only keeps the first frame from being
// a full-screen sheet of invisible glass.
const FACES_SEED_SIZE = { width: 112, height: 112 };

let facesWindow = null;
let facesPlaceTimer = null;

function facesOverlayWanted() {
  const saved = loadFullSettings().facesWindow;
  return !!saved && typeof saved === "object" && saved.open === true;
}

function setFacesOverlayWanted(open) {
  const saved = loadFullSettings().facesWindow;
  updateSettings({
    facesWindow: { ...(saved && typeof saved === "object" ? saved : {}), open: open === true },
  });
}

// While the call is minimized to circles the overlay stands down — two rows of
// floating circles at once is the collision the shared spot exists to avoid.
// The call window in the STAGE is an ordinary window somewhere else on screen,
// so the overlay stays.
function callCirclesShowing() {
  return (
    !!callWindow &&
    !callWindow.isDestroyed() &&
    callWindow.isVisible() &&
    callWindowChrome(callWindowSize).clickThrough
  );
}

function syncFacesOverlayYield() {
  if (!facesWindow || facesWindow.isDestroyed()) return;
  if (callCirclesShowing()) {
    if (facesWindow.isVisible()) {
      // A hidden window keeps its runtime switches, and the renderer — which
      // is what normally puts them back — sees no mouse while hidden. A drag
      // or a lifted click-through that survived the yield would come back as
      // a window eating clicks over glass, so both are reset on the way down.
      facesSeeThrough.stopDrag();
      facesWindow.setIgnoreMouseEvents(true, { forward: true });
      facesWindow.hide();
    }
  } else if (!facesWindow.isVisible()) {
    // showInactive, always: the overlay is a glance you keep beside your work,
    // and one that stole the keyboard when a call ended would be worse than
    // none at all.
    facesWindow.showInactive();
  }
}

function createFacesWindow() {
  if (facesWindow && !facesWindow.isDestroyed()) {
    syncFacesOverlayYield();
    return facesWindow;
  }
  const zoom = getAutoZoomFactor();
  const win = new BrowserWindow({
    ...FACES_SEED_SIZE,
    // Born see-through, same reason as the call window: `transparent` and
    // `frame` are construction options, and everything this window ever shows
    // is circles on glass.
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    // No taskbar entry: it has no title bar to recover it from, and closing it
    // is the entry button's job, not the window manager's.
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`, "--faces-window"],
      // Presence must keep moving while the overlay sits unfocused over other
      // apps — which is the only way it is ever used.
      backgroundThrottling: false,
      // Same flag as the call window, for the same reason: the overlay centres
      // photo circles on faces with the Shape Detection API where available.
      enableBlinkFeatures: "FaceDetector",
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
  });
  facesWindow = win;
  const pos = circlesPosition(FACES_SEED_SIZE);
  win.setPosition(pos.x, pos.y);
  win.setAlwaysOnTop(true, "floating");
  // Follow the person between desktops and stay visible over a full-screen
  // app — where a glance at the team is most needed and least reachable.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // `forward: true` keeps the renderer receiving mouse MOVES while it ignores
  // clicks — without it the window would go deaf the moment the pointer left a
  // circle and could never learn that it came back.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`${currentBaseUrl}${FACES_PATH}`);
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    syncFacesOverlayYield();
  });
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(getAutoZoomFactor());
    win.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
  });
  // Same rule as every window: new-window links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Its moves write the SHARED circles slot, debounced like every saver here.
  const saveFacesPlace = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const [x, y] = win.getPosition();
    updateSettings({ callPanelWindow: { ...loadCallPanelState(), circles: { x, y } } });
  };
  win.on("move", () => {
    clearTimeout(facesPlaceTimer);
    facesPlaceTimer = setTimeout(saveFacesPlace, 400);
  });
  win.on("close", () => {
    // Flush, not drop: a drag that ended within the debounce window is the
    // person's last word on where the circles live.
    clearTimeout(facesPlaceTimer);
    saveFacesPlace();
  });
  win.on("closed", () => {
    clearTimeout(facesPlaceTimer);
    if (facesWindow === win) facesWindow = null;
    broadcastWindowRole();
  });
  broadcastWindowRole();
  return win;
}

function senderIsFacesWindow(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && !win.isDestroyed() && win === facesWindow ? win : null;
}

const facesSeeThrough = registerSeeThroughIpc("faces-window", senderIsFacesWindow, {
  getWindow: () => facesWindow,
});

// Opening is a declaration — "keep the team over my work" — so it persists;
// closing is its withdrawal. Any app window may ask: the entry button lives in
// the people window, and the overlay's own chrome is what closes it.
ipcMain.handle("open-faces-window", () => {
  setFacesOverlayWanted(true);
  createFacesWindow();
});

ipcMain.handle("close-faces-window", () => {
  setFacesOverlayWanted(false);
  if (facesWindow && !facesWindow.isDestroyed()) facesWindow.close();
});

ipcMain.handle("get-faces-window-open", () => !!facesWindow && !facesWindow.isDestroyed());

// ---------------------------------------------------------------------------
// Multi-window notification routing. Every window runs the same web app and
// would otherwise fire its own banner and sound for the same event. Main is
// the one process that sees all windows, so it (a) collapses duplicates,
// (b) suppresses banners while ANY app window is focused, (c) elects ONE
// leader window that may play notification sounds, and (d) lands a banner
// click in the window best placed to show the target. Policy lives in
// notificationRouter.js; this block only feeds it window facts.
// ---------------------------------------------------------------------------

// webContents.id → what that renderer shows: { active, open: [{id,path}], inCall }
const windowStates = new Map();
// BrowserWindow.id → last time it held focus (tie-breaker for routing/leader)
const lastFocusedAt = new Map();
const recentBanners = new RecentKeys();

// The app windows that count for routing: main + detached tab windows + the
// people window. The palette is a floating summon, never a place a banner
// should land or sound.
function appWindows() {
  const out = [];
  if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow);
  for (const w of tabWindows) if (!w.isDestroyed()) out.push(w);
  if (peopleWindow && !peopleWindow.isDestroyed()) out.push(peopleWindow);
  // The call panel counts: `anyInCall` is computed from these windows' reports,
  // and it is what makes every OTHER window show "in a huddle in another
  // window" instead of drawing a second dock for a call it does not hold.
  if (callWindow && !callWindow.isDestroyed()) out.push(callWindow);
  return out;
}

function describeWindows() {
  return appWindows().map((win) => {
    const st = windowStates.get(win.webContents.id) || {};
    return {
      id: win.id,
      isMain: win === mainWindow,
      isPeople: win === peopleWindow,
      // The call panel bypasses the dashboard layout, same as the buddy list.
      // Routing that wants a dashboard surface needs to tell it apart from an
      // ordinary detached tab window.
      isCallPanel: win === callWindow,
      focused: win.isFocused(),
      lastFocusedAt: lastFocusedAt.get(win.id) || 0,
      active: st.active || null,
      open: Array.isArray(st.open) ? st.open : [],
      inCall: st.inCall === true,
    };
  });
}

function isAppFocused() {
  return appWindows().some((w) => w.isFocused());
}

// Tell every window its role. Coalesced to a tick: focus flips, reports and
// window churn arrive in bursts.
let roleBroadcastTimer = null;
function broadcastWindowRole() {
  if (roleBroadcastTimer) return;
  roleBroadcastTimer = setTimeout(() => {
    roleBroadcastTimer = null;
    const windows = describeWindows();
    const leader = chooseLeader(windows);
    const anyInCall = windows.some((w) => w.inCall);
    const appFocused = windows.some((w) => w.focused);
    // Whether a people window exists at all — every window needs it: the one
    // that IS it renders the panel, the others stand down from the pumps and
    // surfaces it owns.
    const hasPeople = !!peopleWindow && !peopleWindow.isDestroyed();
    // Whether the call has a window of its own. The call lives THERE, so no
    // other window draws a dock for it — whichever of its three sizes it is in.
    const hasCallPanel = !!callWindow && !callWindow.isDestroyed();
    // Whether the faces overlay exists (it may be yielding to a call). The
    // people window's toggle reads this, so a close from the overlay's own
    // chrome — or from another window — is reflected everywhere.
    const hasFaces = !!facesWindow && !facesWindow.isDestroyed();
    for (const win of appWindows()) {
      // A window can be past its render frame's disposal and not yet report
      // isDestroyed(), and sending into that gap throws "Render frame was
      // disposed before WebFrameMain could be accessed". The broadcast is
      // deferred by a tick precisely because windows churn, so the gap is not
      // rare — and the call panel, which is created and closed once per call,
      // walks through it far more often than the windows this code was
      // written for. Observed in a from-source run.
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send("window-role", {
        leader: !!leader && leader.id === win.id,
        appFocused,
        anyInCall,
        peopleWindow: hasPeople,
        callPanel: hasCallPanel,
        facesOverlay: hasFaces,
      });
    }
    // The overlay runs the same web app but is never the app's voice: not
    // electable, not a banner target (it ignores clicks), and the web side
    // defaults to leader until told otherwise — so it is told, every time,
    // outside the election.
    if (hasFaces && !facesWindow.webContents.isDestroyed()) {
      facesWindow.webContents.send("window-role", {
        leader: false,
        appFocused,
        anyInCall,
        peopleWindow: hasPeople,
        callPanel: hasCallPanel,
        facesOverlay: true,
      });
    }
  }, 30);
}

app.on("browser-window-focus", (_e, win) => {
  lastFocusedAt.set(win.id, Date.now());
  broadcastWindowRole();
});
app.on("browser-window-blur", () => broadcastWindowRole());

ipcMain.on("report-window-state", (e, state) => {
  if (!state || typeof state !== "object") return;
  windowStates.set(e.sender.id, {
    active: typeof state.active === "string" ? state.active : null,
    open: Array.isArray(state.open)
      ? state.open.filter((t) => t && typeof t.path === "string").map((t) => ({ id: t.id ?? null, path: t.path }))
      : [],
    inCall: state.inCall === true,
  });
  e.sender.once("destroyed", () => windowStates.delete(e.sender.id));
  broadcastWindowRole();
});

function sendNavigate(win, navPath, tabId) {
  const detail = tabId ? { path: navPath, tabId } : navPath;
  win.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify(detail)} }))`
  );
}

// A banner was clicked: land in the best window for its target. With no
// window at all (macOS keeps the app alive with every window closed), boot the
// main window and let the deep-link buffer deliver the path on load.
function openNotificationTarget(data) {
  const route = data?.route || (data?.conversationId ? `/conversation/${data.conversationId}` : null);
  const pick = pickWindow(describeWindows(), { route, kind: data?.kind || null });
  if (!pick) {
    if (route) deepLinkUrl = `codecast://open${route}`;
    createWindow();
    return;
  }
  const win = BrowserWindow.fromId(pick.window.id);
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  if (route) sendNavigate(win, route, pick.tabId);
}

function createPaletteWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  // The compose card fills this window (94vw × 88vh), so the window IS the box's
  // size. ~30% wider than the old 740×580, only modestly taller — a proportional
  // bump made the empty new-session state a cavern, so we grow width more.
  const winWidth = 1000;
  const winHeight = 680;

  paletteWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round((screenWidth - winWidth) / 2),
    y: Math.round(screenHeight * 0.18),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const win = paletteWindow;

  win.loadURL(`${currentBaseUrl}/palette`);

  // Same rule as the main window: new-window links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript(
        "document.documentElement.classList.add('electron-desktop')"
      );
    }
  });

  win.on("blur", () => {
    hidePalette();
  });

  win.on("closed", () => {
    if (paletteWindow === win) paletteWindow = null;
  });
}

function togglePalette() {
  if (!paletteWindow) {
    createPaletteWindow();
    paletteWindow.once("ready-to-show", () => {
      showPalette();
    });
    return;
  }

  if (paletteWindow.isVisible()) {
    hidePalette();
  } else {
    showPalette();
  }
}

// Place the palette window (position only). Does NOT show/focus — that's
// revealPaletteWindow, run AFTER the renderer reports the right face is painted,
// so we never flash the previous face during the swap.
function placePaletteWindow() {
  if (!paletteWindow) return;
  // Capture BEFORE the palette takes focus: was Codecast's own window the one
  // being summoned over? Enter's fire-and-forget hand-back (compose-submit)
  // must step back into the main window in that case, not app.hide() past it
  // to whatever app sits behind.
  paletteSummonedOverSelf = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  // Reposition to center of current display
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width: sw, height: sh } = display.workAreaSize;
  const { x: dx, y: dy } = display.workArea;
  const [winWidth, winHeight] = paletteWindow.getSize();
  paletteWindow.setPosition(
    Math.round(dx + (sw - winWidth) / 2),
    Math.round(dy + sh * 0.18)
  );
}

function revealPaletteWindow() {
  if (!paletteWindow) return;
  paletteWindow.show();
  // When summoned over another app (Chrome, etc.), show()+focus() alone do NOT
  // make this a background app's window the OS "key window" on macOS — so the
  // web autofocus lands on a non-key window and keystrokes go nowhere. Steal
  // app activation (Spotlight-style) so the palette becomes key and its input
  // actually receives focus. Enter's fire-and-forget app.hide() steps back out.
  if (process.platform === "darwin") app.focus({ steal: true });
  paletteWindow.focus();
}

// Switch the palette window to the requested face (compose/search), then reveal
// it only once the renderer acks it has painted that face — so the previous face
// never flashes before the swap. The fallback timer covers older web builds (no
// ack) and any missed ack, so the window can't get stuck hidden.
let revealFallbackTimer = null;
let pendingRevealMode = null; // "compose" | "search" | null
function showPaletteFace(channel) {
  if (!paletteWindow) return;
  placePaletteWindow();
  pendingRevealMode = channel === "compose-show" ? "compose" : "search";
  clearTimeout(revealFallbackTimer);
  const waitingFor = pendingRevealMode;
  revealFallbackTimer = setTimeout(() => finishReveal(waitingFor), 200);
  paletteWindow.webContents.send(channel);
}

function finishReveal(mode) {
  if (!pendingRevealMode) return;
  // Reveal only when the renderer painted the face we asked for, so a stale ack
  // for the previous face can't reveal it mid-swap. `mode` undefined = older web
  // build whose ack carries no face → trust it (best effort).
  if (mode && mode !== pendingRevealMode) return;
  pendingRevealMode = null;
  clearTimeout(revealFallbackTimer);
  revealFallbackTimer = null;
  revealPaletteWindow();
}

function showPalette() {
  if (!paletteWindow) return;
  showPaletteFace("palette-show");
}

// Summon the same palette window into new-session compose mode. Used by the
// global "New Session" shortcut and the tray/dock/app menus.
function showCompose() {
  if (!paletteWindow) {
    createPaletteWindow();
    paletteWindow.once("ready-to-show", () => {
      showPaletteFace("compose-show");
    });
    return;
  }
  showPaletteFace("compose-show");
}

function hidePalette() {
  // Always cancel a pending reveal first — a late ack (or the fallback) must not
  // pop a window the user has already dismissed.
  pendingRevealMode = null;
  clearTimeout(revealFallbackTimer);
  revealFallbackTimer = null;
  if (!paletteWindow || !paletteWindow.isVisible()) return;
  paletteWindow.hide();
}

// ---------------------------------------------------------------------------
// The meeting-offer window: the record-this-meeting card as a small chromeless
// window in the top-right corner (route /meeting-offer). The palette's polite
// sibling — same glass, opposite manners: summoned by the meeting poller
// rather than a keystroke, revealed with showInactive and NEVER focused. The
// person it appears to is joining a meeting; a card taking their keystrokes is
// worse than no card at all.
//
// The renderer owns the content AND the recording it starts, so the shell's
// whole job is shape and place: the page reports its content size
// (meeting-offer-size), the shell reshapes the window around it anchored to
// the corner, and the first report is the reveal signal — so an offer landing
// in a still-booting window shows exactly when there is something to see.
// ---------------------------------------------------------------------------
let meetingOfferWindow = null;
const MEETING_OFFER_MARGIN = 16;

function createMeetingOfferWindow() {
  const zoom = getAutoZoomFactor();
  const win = new BrowserWindow({
    width: 360,
    height: 64,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      additionalArguments: [`--zoom-factor=${zoom}`, "--meeting-offer-window"],
      // It records. While it does, it is by definition behind the meeting —
      // throttled timers would starve the transcript's heartbeat and the
      // orphan sweep would end a recording that is still running.
      backgroundThrottling: false,
    },
  });
  meetingOfferWindow = win;
  // Over a fullscreen meeting app — which is exactly where the person is when
  // this card matters.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`${currentBaseUrl}/meeting-offer`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-finish-load", () => {
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript(
        "document.documentElement.classList.add('electron-desktop')"
      );
    }
  });
  win.on("closed", () => {
    if (meetingOfferWindow === win) meetingOfferWindow = null;
  });
}

// Top-right of the display the cursor is on, growing downward and leftward so
// the corner anchor holds while the card expands.
function placeMeetingOfferWindow(width, height) {
  const win = meetingOfferWindow;
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  win.setBounds({
    x: Math.round(area.x + area.width - width - MEETING_OFFER_MARGIN),
    y: Math.round(area.y + MEETING_OFFER_MARGIN),
    width: Math.round(width),
    height: Math.round(height),
  });
}

ipcMain.on("meeting-offer-size", (e, size) => {
  const win = meetingOfferWindow;
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  const width = Math.max(60, Math.min(560, Math.round(Number(size?.width) || 360)));
  const height = Math.max(26, Math.min(480, Math.round(Number(size?.height) || 64)));
  placeMeetingOfferWindow(width, height);
  if (!win.isVisible()) win.showInactive();
});

ipcMain.on("meeting-offer-hide", (e) => {
  const win = meetingOfferWindow;
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  win.hide();
});

// "Open the transcript" from the recording face: the card is not a place to
// read, so the transcript lands in the main window.
ipcMain.on("meeting-offer-open-call", (e, id) => {
  const win = meetingOfferWindow;
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  const clean = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  if (clean) navigateMain(`/calls/${clean}`);
});

// Open a FULL new session in the main window (Ctrl+N model): bring the app
// forward and let the web shell start the deferred session inline (it renders
// NewSessionView for the empty conversation). This is the primary "New Session"
// affordance — distinct from the Ctrl+Shift+N palette (showCompose), which is the
// quick floating summon. The compose palette's "open full" hand-off also lands here.
function openFullSessionInMain() {
  hidePalette();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.executeJavaScript(
    "window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"
  );
}

// Cmd+N: the focused window pops its current view out into a window of its
// own — the same move as the tab strip's "Open in new window". The renderer
// owns the answer to "what is the current view" (the active tab, or the page
// of a detached window), so the shell only asks; the detach itself comes back
// over the detach-tab IPC.
function detachFocusedView(win) {
  const target = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
  if (!target || target.isDestroyed()) return;
  if (target !== mainWindow && !tabWindows.has(target)) return;
  target.webContents.executeJavaScript(
    "window.__CODECAST_DETACH_VIEW && window.__CODECAST_DETACH_VIEW()"
  );
}

function navigateMain(navPath) {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify(navPath)} }))`
  );
}

function toggleEnvironment() {
  if (!mainWindow) return;
  currentBaseUrl = currentBaseUrl === PROD_URL ? LOCAL_URL : PROD_URL;
  const env = currentBaseUrl === PROD_URL ? "prod" : "local";
  updateSettings({ env });
  mainWindow.loadURL(currentBaseUrl);
  mainWindow.webContents.once("did-finish-load", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
    mainWindow.webContents.executeJavaScript(
      `document.title = '[${env.toUpperCase()}] ' + document.title`
    );
  });
  if (paletteWindow) {
    paletteWindow.destroy();
    paletteWindow = null;
  }
  createPaletteWindow();
  dropSpareTabWindow();
  warmSpareTabWindow();
  // The people window shows the same environment's roster; leaving it on the
  // old origin would have it watching a different world than the main window.
  if (peopleWindow && !peopleWindow.isDestroyed()) {
    peopleWindow.loadURL(`${currentBaseUrl}${PEOPLE_PATH}`);
  }
  // Same rule for the faces overlay.
  if (facesWindow && !facesWindow.isDestroyed()) {
    facesWindow.loadURL(`${currentBaseUrl}${FACES_PATH}`);
  }
}

function createTray() {
  // Load the base name so AppKit auto-picks the @2x file on Retina and renders
  // the mark at its natural point size (the source PNGs are already sized for
  // the menubar — 22×18 / 44×36 — so no squishing resize is needed).
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "Show Codecast", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "New Session", click: () => openFullSessionInMain() },
    { label: "New Quick Session", click: () => showCompose() },
    { label: "Command Palette", click: () => togglePalette() },
    { type: "separator" },
    { label: "Dashboard", click: () => navigateMain("/dashboard") },
    { label: "Inbox", click: () => navigateMain("/inbox") },
    { label: "Tasks", click: () => navigateMain("/tasks") },
    { type: "separator" },
    { label: "Check for Updates…", click: () => checkForDesktopUpdate({ manual: true }) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Quit Codecast", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Codecast");
}

function buildAppMenu() {
  const template = [
    {
      label: "Codecast",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Check for Updates…", click: () => checkForDesktopUpdate({ manual: true }) },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => navigateMain("/settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: (_item, win) => detachFocusedView(win),
        },
        {
          label: "New Session",
          accelerator: "CommandOrControl+Shift+N",
          click: () => openFullSessionInMain(),
        },
        // No accelerators here: these mirror native windows the global
        // shortcuts already open (newSession / togglePalette), and binding the
        // same keys in the menu would hijack them from the web app (the native
        // menu intercepts before the renderer sees the keystroke).
        { label: "New Quick Session", click: () => showCompose() },
        { label: "Command Palette", click: () => togglePalette() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Dashboard", click: () => navigateMain("/dashboard") },
        { label: "Inbox", click: () => navigateMain("/inbox") },
        { label: "Tasks", click: () => navigateMain("/tasks") },
        { label: "Plans", click: () => navigateMain("/plans") },
        { label: "Docs", click: () => navigateMain("/docs") },
        { type: "separator" },
        { label: "Back", accelerator: "CommandOrControl+[", click: () => mainWindow?.webContents.goBack() },
        { label: "Forward", accelerator: "CommandOrControl+]", click: () => mainWindow?.webContents.goForward() },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Command Palette", click: () => togglePalette() },
        { label: "Switch Environment", click: () => toggleEnvironment() },
        { type: "separator" },
        { role: "front" },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Documentation", click: () => shell.openExternal("https://codecast.sh/documentation") },
        { label: "What's New", click: () => shell.openExternal("https://codecast.sh/changelog") },
        { label: "Keyboard Shortcuts", click: () => navigateMain("/settings") },
        { type: "separator" },
        { label: "Check for Updates…", click: () => checkForDesktopUpdate({ manual: true }) },
        { label: "Codecast Website", click: () => shell.openExternal("https://codecast.sh") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Self-contained desktop updater.
//
// Squirrel.Mac (electron-updater's install step) is dead on macOS 26: launchd
// accepts the ShipIt job but never runs it, so quitAndInstall() quits the app
// and nothing ever swaps the bundle. So we don't touch Squirrel at all. Instead
// we mirror the daemon's proven update channel in-process: read the published
// electron-builder feed, stream-download the zip (with real progress), verify
// its sha512 and that it's signed by OUR team, stage the verified bundle, and —
// on a deliberate "Restart now" — hand a detached helper the job of swapping
// the running bundle and relaunching us in the FOREGROUND once we exit.
//
// This needs no launchd, no Squirrel, no daemon, and reports real download
// progress to the renderer over the existing `update-status` IPC.
// ---------------------------------------------------------------------------
const DESKTOP_FEED = "https://dl.codecast.sh/desktop/latest-mac.yml";
const DESKTOP_BASE = "https://dl.codecast.sh/desktop";
// Our Apple Developer Team ID — the swapped bundle MUST be signed by us.
const EXPECTED_TEAM_ID = "WRG9THCK9Q";

// Most recent {status,version,percent}, replayed to any window that loads after
// it was emitted (boot/reload) so the banner never misses the download.
let lastUpdateStatus = null;
// { version, incomingPath, bundlePath } once a verified bundle is staged.
let stagedUpdate = null;
// The in-flight update run and its abort handle. A promise (not a boolean
// flag) so a user-initiated retry can abort a wedged download, WAIT for it to
// settle, and start fresh — the old boolean made "Try again" a silent no-op
// while a stalled stream held it forever (v1.1.84 rollout).
let updateRun = null;
let updateAbort = null;

function emitUpdateStatus(status) {
  lastUpdateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", status);
  }
}

// The .app bundle we're actually running from (NOT hardcoded to /Applications —
// respect wherever the user installed it). exe is <bundle>/Contents/MacOS/Codecast.
function installedBundlePath() {
  const bundle = path.dirname(path.dirname(path.dirname(app.getPath("exe"))));
  return bundle.endsWith(".app") ? bundle : null;
}

function cmpVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Parse only the fields we need from latest-mac.yml (no YAML dependency).
function parseFeed(text) {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  let zip, sha512;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/url:\s*(\S+-mac\.zip)\s*$/);
    if (m) {
      zip = m[1].trim();
      const sm = lines[i + 1]?.match(/sha512:\s*(\S+)\s*$/);
      if (sm) sha512 = sm[1].trim();
      break;
    }
  }
  return { version, zip, sha512 };
}

// Network layer (redirect-following GET, feed fetch, resumable download with
// inactivity timeouts and abort support) lives in updaterNet.js — pure Node,
// so its stall/resume/abort behavior is testable outside a packaged app.
const { fetchText, downloadResumable } = require("./updaterNet");

function execFileP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// The extracted bundle must be a valid, untampered signature from our team.
async function verifyBundleSignature(appPath) {
  const verify = await execFileP("/usr/bin/codesign", ["--verify", "--strict", "--deep", appPath]);
  if (!verify.ok) return false;
  const info = await execFileP("/usr/bin/codesign", ["-dvv", appPath]);
  return `${info.stdout}${info.stderr}`.includes(`TeamIdentifier=${EXPECTED_TEAM_ID}`);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// Check the feed and, if newer (or forced), download → verify → stage a bundle
// ready to swap in on the next "Restart now". Fire-and-forget; never throws.
// opts.userInitiated (any renderer "Try again" / menu check): a check that
// arrives while a run is already in flight ABORTS that run and starts fresh —
// the in-flight one may be a download wedged on a dead socket, and returning
// silently here is what made the retry button do nothing.
async function checkForDesktopUpdate(opts = {}) {
  if (process.platform !== "darwin" || !app.isPackaged) {
    if (opts.manual) showNativeNotification("Updates unavailable", "Auto-update only runs in the installed desktop app.");
    return;
  }
  if (updateRun) {
    if (!opts.userInitiated && !opts.manual) return; // background tick — one run at a time
    updateAbort?.abort();
    await updateRun.catch(() => {});
  }
  // Already downloaded and waiting — just re-surface it for a manual check.
  if (stagedUpdate) {
    emitUpdateStatus({ status: "ready", version: stagedUpdate.version });
    if (opts.manual) showNativeNotification(`Codecast ${stagedUpdate.version} is ready`, "Click to restart and install.", () => installUpdateAndRestart());
    return;
  }
  const run = runDesktopUpdateCheck(opts);
  updateRun = run;
  try {
    await run;
  } finally {
    if (updateRun === run) { updateRun = null; updateAbort = null; }
  }
}

async function runDesktopUpdateCheck(opts) {
  const bundle = installedBundlePath();
  if (!bundle) return;

  const abort = new AbortController();
  updateAbort = abort;
  const work = path.join(app.getPath("userData"), "update-stage");
  try {
    const { version, zip, sha512 } = parseFeed(await fetchText(DESKTOP_FEED));
    if (!version || !zip || !sha512) throw new Error("could not parse feed");
    if (cmpVersions(version, app.getVersion()) <= 0 && !opts.force) {
      if (opts.manual) showNativeNotification("Codecast is up to date", `You're on the latest version (${app.getVersion()}).`);
      return;
    }

    emitUpdateStatus({ status: "available", version });
    rmrf(work);
    fs.mkdirSync(work, { recursive: true });
    const zipPath = path.join(work, zip);

    emitUpdateStatus({ status: "downloading", version, percent: 0 });
    const got = await downloadResumable(`${DESKTOP_BASE}/${zip}`, zipPath, {
      signal: abort.signal,
      onProgress: (percent) => emitUpdateStatus({ status: "downloading", version, percent }),
    });
    if (got !== sha512) throw new Error("sha512 mismatch");

    const extractDir = path.join(work, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    const ex = await execFileP("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
    if (!ex.ok) throw new Error("extract failed");
    const newApp = path.join(extractDir, "Codecast.app");
    if (!fs.existsSync(newApp)) throw new Error("Codecast.app missing from archive");
    if (!(await verifyBundleSignature(newApp))) throw new Error("signature/team verification failed");

    // Pre-stage a sibling copy on the SAME volume as the running bundle so the
    // post-quit swap is just two atomic renames (minimal downtime, no half-state).
    const incoming = path.join(path.dirname(bundle), ".Codecast.app.incoming");
    rmrf(incoming);
    const cp = await execFileP("/usr/bin/ditto", [newApp, incoming]);
    if (!cp.ok) throw new Error("stage copy failed");
    rmrf(work);

    stagedUpdate = { version, incomingPath: incoming, bundlePath: bundle };
    emitUpdateStatus({ status: "ready", version });
    showNativeNotification(
      `Codecast ${version} is ready`,
      "Click to restart and install the update.",
      () => installUpdateAndRestart(),
    );
  } catch (e) {
    console.error("desktop update:", e?.message || e);
    rmrf(work);
    // An aborted run was superseded by a user retry — the fresh run emits its
    // own statuses immediately, so don't flash a spurious error over them.
    if (!e?.aborted) {
      emitUpdateStatus({ status: "error", version: lastUpdateStatus?.version });
      if (opts.manual) showNativeNotification("Update check failed", "Couldn't reach the update server. Try again later.");
    }
  }
}

// Apply the staged update: a detached helper waits for THIS process to exit,
// swaps the bundle via two atomic renames, clears quarantine, then relaunches
// us in the FOREGROUND. Quitting ourselves is what lets the rename succeed.
let updateInstallTriggered = false;
function installUpdateAndRestart() {
  if (updateInstallTriggered || !stagedUpdate) return;
  updateInstallTriggered = true;
  const { incomingPath, bundlePath } = stagedUpdate;
  const oldPath = path.join(path.dirname(bundlePath), ".Codecast.app.old");
  const pid = process.pid;
  const sh = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`; // single-quote for /bin/sh
  const script = [
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${sh(oldPath)}`,
    `mv ${sh(bundlePath)} ${sh(oldPath)} && mv ${sh(incomingPath)} ${sh(bundlePath)} || { mv ${sh(oldPath)} ${sh(bundlePath)} 2>/dev/null; exit 1; }`,
    `/usr/bin/xattr -dr com.apple.quarantine ${sh(bundlePath)} 2>/dev/null`,
    `rm -rf ${sh(oldPath)}`,
    `/usr/bin/open ${sh(bundlePath)}`,
  ].join("\n");
  try {
    spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    console.error("update swap helper failed to spawn:", e?.message);
  }
  app.quit();
}

// IPC handlers
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("set-badge-count", (_e, count) => app.setBadgeCount(count));
ipcMain.handle("get-env", () => (currentBaseUrl === PROD_URL ? "prod" : "local"));
// OS-wide seconds since last user input — feeds the web layer's presence
// heartbeat so the server knows a human is at this machine even while
// Codecast itself is unfocused. powerMonitor is only usable after app ready,
// which holds whenever this handler runs: renderers exist only post-ready.
ipcMain.handle("get-system-idle-seconds", () => powerMonitor.getSystemIdleTime());
ipcMain.handle("restart-for-update", () => installUpdateAndRestart());
// Any renderer-invoked check is user-initiated ("Try again" / "Update now"),
// which lets it supersede a wedged in-flight download (see checkForDesktopUpdate).
ipcMain.handle("check-for-update", (_e, opts) => checkForDesktopUpdate({ manual: opts?.manual === true, userInitiated: true }));
// Returns { shown } so the renderer knows whether IT announced the event.
// Every window reports the same server row; the first report wins the banner,
// duplicates inside the TTL are dropped, and nothing banners while an app
// window is focused (the user already sees the bell / toast there).
ipcMain.handle("show-notification", (_e, payload) => {
  const { title, body, data } = payload || {};
  if (isAppFocused()) return { shown: false, reason: "focused" };
  if (!recentBanners.claim(RecentKeys.keyFor(payload))) return { shown: false, reason: "duplicate" };
  // `route` is the one click target (chat message, task, doc...); the bare
  // conversationId form predates it and stays as the fallback.
  showNativeNotification(title, body, () => openNotificationTarget(data));
  return { shown: true };
});

// OS-level permissions (notifications, microphone, camera, screen) read from
// the OS itself — see osPermissions.js. Unpackaged dev runs register with
// macOS under Electron's own bundle id, so System Settings opens that one.
const osPermissions = createOsPermissions({
  electron: { systemPreferences, desktopCapturer, shell },
  bundleId: app.isPackaged ? "sh.codecast.desktop" : "com.github.Electron",
});
ipcMain.handle("get-os-permissions", () => osPermissions.getAll());
ipcMain.handle("request-os-permission", (_e, kind) => osPermissions.request(String(kind)));
ipcMain.handle("open-os-permission-settings", (_e, kind) => osPermissions.openSettings(String(kind)));

// Sign-in hands its OAuth flow to the user's real browser (issue #20): the
// embedded window has no Google/GitHub sessions. https-only — the renderer
// only ever passes app-origin auth URLs, and anything else has no business
// being launched from here.
ipcMain.handle("open-external", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
});

// Palette IPC
// The palette renderer has painted a face (compose/search) — reveal the window
// if it's the one we asked for.
ipcMain.on("palette-ready", (_e, mode) => {
  finishReveal(mode);
});

ipcMain.on("palette-navigate", (_e, navPath) => {
  hidePalette();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify(navPath)} }))`
    );
  }
});

ipcMain.on("palette-hide", () => {
  hidePalette();
});

ipcMain.on("palette-new-session", () => {
  openFullSessionInMain();
});

// The compose popup reports back after the user sends the first message. The
// session was already created + the message sent from the popup's renderer; all
// we do here is manage focus:
//   navigate → bring Codecast forward on the new conversation (Cmd+Enter)
//   else     → fire-and-forget: hide the popup and step out of the app (Enter)
ipcMain.on("compose-submit", (_e, data) => {
  hidePalette();
  if (data?.navigate && data?.conversationId && mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify("/conversation/" + data.conversationId)} }))`
    );
  } else if (!data?.navigate) {
    if (paletteSummonedOverSelf && mainWindow && !mainWindow.isDestroyed()) {
      // Summoned while Codecast was frontmost — "stepping back out" means
      // returning to the main window, not hiding the whole app.
      mainWindow.show();
      mainWindow.focus();
    } else if (process.platform === "darwin") {
      app.hide();
    }
  }
});

// Settings IPC
ipcMain.handle("get-shortcuts", () => loadSettings());
// Richer readout for the settings UI: current bindings, the defaults (so the
// web can offer "reset to default" without hardcoding them), and which
// bindings failed to register (owned by another app / malformed).
ipcMain.handle("get-shortcut-config", () => ({
  shortcuts: loadSettings(),
  defaults: DEFAULT_SHORTCUTS,
  issues: shortcutIssues,
}));
ipcMain.handle("set-shortcut", (_e, key, accelerator) => {
  const shortcuts = loadSettings();
  shortcuts[key] = accelerator;
  saveSettings(shortcuts);
  registerShortcuts();
  return loadSettings();
});

// ---------------------------------------------------------------------------
// Meeting detection. The shell notices a meeting app starting and offers to
// record it; the answer, and the recording itself, belong to the web layer.
//
// WHAT IT READS: the names of running programs, once every 20 seconds, and
// nothing else. No window titles, no window contents, no calendar. The
// setting's copy says exactly that, and meetingDetector.js is what makes the
// sentence true.
//
// WHAT IT COSTS WHEN OFF: nothing. No timer, no `ps`, no memory of what is
// running. The poller exists only while the setting asks for it.
// ---------------------------------------------------------------------------

function loadMeetingDetect() {
  return mergeMeetingDetect(loadFullSettings().meetingDetect);
}

function saveMeetingDetect(patch) {
  const next = mergeMeetingDetect({ ...loadMeetingDetect(), ...patch });
  updateSettings({ meetingDetect: next });
  syncMeetingWatch();
  return next;
}

// macOS only: the table is mac app bundles and `ps -Ao comm=` is a mac
// invocation. Elsewhere the setting is not offered rather than offered and
// quietly dead.
function canDetectMeetings() {
  return process.platform === "darwin";
}

const MEETING_POLL_MS = 20_000;
let meetingTimer = null;
// The meeting apps seen on the last tick. `null` means nothing has been
// observed yet, which startedApps reads as a baseline — whatever is already
// open when the timer starts is the status quo, not a meeting beginning.
let meetingRunning = null;
let meetingPsInFlight = false;

async function meetingTick() {
  // One `ps` at a time, and one per tick. A loaded machine can take longer to
  // answer than the interval, and stacking spawns is exactly how a poller
  // becomes a bigger problem than the thing it watches for.
  if (meetingPsInFlight) return;
  meetingPsInFlight = true;
  let out = "";
  try {
    const res = await execFileP("/bin/ps", ["-Ao", "comm="]);
    if (!res.ok) return;
    out = res.stdout;
  } finally {
    meetingPsInFlight = false;
  }
  const observed = detectMeetingApps(out);
  const started = startedApps(meetingRunning, observed);
  meetingRunning = observed;
  if (!started.length) return;
  const settings = loadMeetingDetect();
  for (const id of started) {
    const decision = decideOffer(settings, id);
    if (decision !== "skip") offerToRecord(id, decision);
  }
}

// The offer goes to the dedicated meeting-offer window and TAKES NO FOCUS —
// nothing is raised or sounded here. The window reveals itself (inactive, in
// the corner) when its renderer reports content, and the chime is the
// renderer's. A card that jumps in front of somebody joining a meeting is
// worse than a recording they had to start by hand.
function offerToRecord(appId, decision) {
  if (!meetingOfferWindow) createMeetingOfferWindow();
  const win = meetingOfferWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send("meeting-detected", {
    app: appId,
    name: meetingAppName(appId),
    decision,
    at: Date.now(),
  });
}

// Start or stop the poller to match the setting. Idempotent, so a change from
// ask to auto leaves the timer — and the running set — exactly as they were:
// restarting would re-baseline, and re-baselining is silent, not noisy.
function syncMeetingWatch() {
  const on = canDetectMeetings() && loadMeetingDetect().mode !== "off";
  if (on === !!meetingTimer) return;
  if (!on) {
    clearInterval(meetingTimer);
    meetingTimer = null;
    meetingRunning = null;
    return;
  }
  meetingRunning = null;
  meetingTimer = setInterval(() => { meetingTick(); }, MEETING_POLL_MS);
  meetingTick();
}

ipcMain.handle("get-meeting-detect", () => ({
  ...loadMeetingDetect(),
  apps: meetingAppList(),
  supported: canDetectMeetings(),
}));
ipcMain.handle("set-meeting-detect", (_e, patch) => saveMeetingDetect(patch || {}));

const SHORTCUT_HANDLERS = {
  toggleWindow: () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  },
  togglePalette: () => togglePalette(),
  newSession: () => showCompose(),
  toggleEnv: () => toggleEnvironment(),
};

// Bindings that failed their last registration attempt, keyed by shortcut key
// with the offending accelerator as value. Surfaced to the settings UI so a
// dead shortcut is diagnosable instead of silent.
let shortcutIssues = {};

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = loadSettings();
  shortcutIssues = {};

  for (const [key, handler] of Object.entries(SHORTCUT_HANDLERS)) {
    const acc = shortcuts[key];
    if (!acc) continue; // "" = binding removed by the user
    let ok = false;
    // register() returns false when another app already holds the accelerator
    // and throws on a malformed one — both must land in issues, not crash.
    try {
      ok = globalShortcut.register(acc, handler);
    } catch {
      ok = false;
    }
    if (!ok) shortcutIssues[key] = acc;
  }
}

app.whenReady().then(() => {
  // Trust the local mkcert dev cert at the network-service layer. This runs
  // before any cert check, so unlike the "certificate-error" event it also
  // covers the Vite HMR WebSocket — not just the page load. callback(0) =
  // trust; callback(-3) = defer to Chromium's normal verification, so every
  // other host (production included) stays strict.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(request.hostname === LOCAL_DEV_HOST ? 0 : -3);
  });

  // ── Capability policy ────────────────────────────────────────────────────
  // The shell is a HOST, not a feature: it grants its own trusted origins the
  // browser capabilities a first-party web app expects, and exposes generic
  // primitives (below, `desktop-sources`) that the web layer composes into
  // features. Adding a media feature, a picker, or a permission-gated API on
  // the web side must never require a shell release — that is the whole
  // reason this list is a policy table and not per-feature branches.
  const isTrustedOrigin = (webContents) => {
    let host = "";
    try {
      host = new URL(webContents.getURL()).hostname;
    } catch {}
    return (
      host === "codecast.sh" ||
      host === LOCAL_DEV_HOST ||
      // Loopback: a Vite port, a worktree's dev server — all this app's code.
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]"
    );
  };
  // Capabilities a trusted first-party page may hold. Anything not listed is
  // denied for everyone (a navigated-to third-party frame gets nothing).
  // The BASELINE ships with the shell; the web layer may EXTEND it at runtime
  // (`host-policy` below), persisted in settings.json, so a new permission-
  // gated web feature never waits on a desktop release. Extension is
  // additive only and gated on the caller being a trusted origin — the web
  // cannot open the door for anyone but itself.
  const BASELINE_PERMISSIONS = [
    "media", "audioCapture", "videoCapture", // huddles: mic + camera
    "display-capture",                       // screen share
    "notifications",
    "clipboard-read", "clipboard-sanitized-write",
    "fullscreen",
    "speaker-selection",                     // audio output picker
  ];
  const trustedPermissions = () =>
    new Set([...BASELINE_PERMISSIONS, ...(loadFullSettings().hostPolicy?.permissions ?? [])]);
  const extraTrustedHosts = () => new Set(loadFullSettings().hostPolicy?.hosts ?? []);
  const isTrustedOriginOrExtended = (webContents) => {
    if (isTrustedOrigin(webContents)) return true;
    try {
      return extraTrustedHosts().has(new URL(webContents.getURL()).hostname);
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(trustedPermissions().has(permission) && isTrustedOriginOrExtended(webContents));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return trustedPermissions().has(permission) && (!webContents || isTrustedOriginOrExtended(webContents));
  });
  // The web layer extends host policy: {permissions?: string[], hosts?: string[]}.
  // Reads back the effective policy so the web can gate on what the shell
  // will actually grant.
  ipcMain.handle("host-policy", (e, patch) => {
    if (!isTrustedOrigin(e.sender)) return null;
    if (patch && typeof patch === "object") {
      const cur = loadFullSettings().hostPolicy ?? {};
      const permissions = new Set([...(cur.permissions ?? []), ...((patch.permissions ?? []).filter((x) => typeof x === "string"))]);
      const hosts = new Set([...(cur.hosts ?? []), ...((patch.hosts ?? []).filter((x) => typeof x === "string"))]);
      updateSettings({ hostPolicy: { permissions: [...permissions], hosts: [...hosts] } });
    }
    return { permissions: [...trustedPermissions()], hosts: [...extraTrustedHosts()], version: app.getVersion() };
  });

  // Screen share. Chromium routes the renderer's getDisplayMedia here for a
  // source. The renderer may PRE-SELECT one (web-built picker over the
  // `desktop-sources` primitive, then `select-display-source`); absent a
  // selection the primary screen is used, so the plain "share my screen"
  // gesture works with zero UI. The selection is single-use — one call, one
  // consent — never a standing grant.
  let pendingDisplaySource = null;
  ipcMain.handle("desktop-sources", async (e, opts) => {
    if (!isTrustedOrigin(e.sender)) return [];
    const types = Array.isArray(opts?.types) ? opts.types.filter((t) => t === "screen" || t === "window") : ["screen", "window"];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      kind: src.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: src.thumbnail.toDataURL(),
    }));
  });
  ipcMain.handle("select-display-source", (e, id) => {
    if (!isTrustedOrigin(e.sender)) return false;
    pendingDisplaySource = typeof id === "string" ? id : null;
    return true;
  });
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wanted = pendingDisplaySource;
    pendingDisplaySource = null;
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
        const pick = (wanted && sources.find((s) => s.id === wanted)) || sources.find((s) => s.id.startsWith("screen:")) || sources[0];
        if (pick) callback({ video: pick, audio: request.audioRequested ? "loopback" : undefined });
        else callback({});
      })
      .catch(() => callback({}));
  });

  app.setAboutPanelOptions({
    applicationName: "Codecast",
    copyright: "Codecast",
    website: "https://codecast.sh",
  });
  createWindow();
  createTray();
  buildAppMenu();
  createPaletteWindow();
  // An overlay somebody kept over their work comes back where they left it.
  if (facesOverlayWanted()) createFacesWindow();
  if (app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: "New Session", click: () => openFullSessionInMain() },
      { label: "Dashboard", click: () => navigateMain("/dashboard") },
      { label: "Inbox", click: () => navigateMain("/inbox") },
    ]));
  }
  registerShortcuts();
  // Starts the meeting poller only if the setting asks for it; off is free.
  syncMeetingWatch();

  // No startup notification needed -- macOS registers the app when
  // Notification.show() is first called from any code path (idle, error, etc.).

  // Auto-update: download in the background shortly after launch (so it's
  // usually already staged + "ready" by the time the user notices the banner),
  // then re-check hourly. The actual install only happens on a deliberate
  // "Restart now" — see checkForDesktopUpdate / installUpdateAndRestart.
  setTimeout(() => { checkForDesktopUpdate(); }, 8000);
  setInterval(() => { checkForDesktopUpdate(); }, 60 * 60 * 1000);
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on("window-all-closed", () => {
  // Don't quit on macOS -- keep in dock/tray
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

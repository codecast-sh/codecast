const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell, screen, Notification, session, powerMonitor, desktopCapturer } = require("electron");
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

// Pin Chromium's download path to our userData dir so macOS TCC never
// probes ~/Documents or ~/Downloads and triggers the permission dialog.
const _ud = app.getPath("userData");
for (const dir of ["downloads", "temp"]) {
  const p = path.join(_ud, dir);
  fs.mkdirSync(p, { recursive: true });
  app.setPath(dir, p);
}

const { pickWindow, chooseLeader, RecentKeys } = require("./notificationRouter");

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

function createTabWindow(navPath) {
  const zoom = getAutoZoomFactor();
  // Cascade from the main window so a breakout never opens exactly on top.
  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    ...(base ? { x: base.x + 40 + tabWindows.size * 24, y: base.y + 40 + tabWindows.size * 24 } : {}),
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
  tabWindows.add(win);

  win.loadURL(`${currentBaseUrl}${navPath}`);
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
  win.on("closed", () => {
    tabWindows.delete(win);
    broadcastWindowRole();
  });
  broadcastWindowRole();
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

// The app windows that count for routing: main + detached tab windows. The
// palette is a floating summon, never a place a banner should land or sound.
function appWindows() {
  const out = [];
  if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow);
  for (const w of tabWindows) if (!w.isDestroyed()) out.push(w);
  return out;
}

function describeWindows() {
  return appWindows().map((win) => {
    const st = windowStates.get(win.webContents.id) || {};
    return {
      id: win.id,
      isMain: win === mainWindow,
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
    for (const win of appWindows()) {
      win.webContents.send("window-role", {
        leader: !!leader && leader.id === win.id,
        appFocused,
        anyInCall,
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
          label: "New Session",
          accelerator: "CommandOrControl+N",
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
  if (app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: "New Session", click: () => openFullSessionInMain() },
      { label: "Dashboard", click: () => navigateMain("/dashboard") },
      { label: "Inbox", click: () => navigateMain("/inbox") },
    ]));
  }
  registerShortcuts();

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

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell, screen, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

app.name = "Codecast";

// Squirrel.Mac registers its install helper as a launchd job named
// "<build.appId>.ShipIt". Keep this in sync with electron-builder's appId.
const SHIPIT_LABEL = "sh.codecast.desktop.ShipIt";

// Pin Chromium's download path to our userData dir so macOS TCC never
// probes ~/Documents or ~/Downloads and triggers the permission dialog.
const _ud = app.getPath("userData");
for (const dir of ["downloads", "temp"]) {
  const p = path.join(_ud, dir);
  fs.mkdirSync(p, { recursive: true });
  app.setPath(dir, p);
}

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
const LOCAL_URL = "http://local.codecast.sh";
const BASE_URL = process.env.CODECAST_URL || PROD_URL;

const DEFAULT_SHORTCUTS = {
  toggleWindow: "CommandOrControl+Alt+Space",
  togglePalette: "Control+Alt+Space",
  newSession: "Control+Shift+N",
  toggleEnv: "CommandOrControl+Alt+L",
};

let mainWindow = null;
let paletteWindow = null;
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
  const s = loadFullSettings();
  const merged = { ...DEFAULT_SHORTCUTS, ...s.shortcuts };
  // Migrate renamed key
  if (merged.toggleCompose && !s.shortcuts?.newSession) {
    merged.newSession = merged.toggleCompose;
  }
  delete merged.toggleCompose;
  return merged;
}

function saveSettings(shortcuts) {
  const settingsPath = getSettingsPath();
  const existing = loadFullSettings();
  existing.shortcuts = shortcuts;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
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

// Deep link protocol
if (process.defaultApp) {
  app.setAsDefaultProtocolClient("codecast", process.execPath, [app.getAppPath()]);
} else {
  app.setAsDefaultProtocolClient("codecast");
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
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("deep-link", url);
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
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
      deepLinkUrl = null;
    }
  });

  mainWindow.webContents.on("did-finish-load", () => {
    clearTimeout(stallTimer);
    stallTimer = null;
    loadAttempts = 0;
    mainWindow.webContents.setZoomFactor(getAutoZoomFactor());
    mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.add('electron-desktop')"
    );
  });


  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(currentBaseUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    clearTimeout(stallTimer);
    mainWindow = null;
  });
}

function createPaletteWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 620;
  const winHeight = 520;

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

function showPalette() {
  if (!paletteWindow) return;
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
  paletteWindow.show();
  paletteWindow.focus();
  paletteWindow.webContents.send("palette-show");
}

function hidePalette() {
  if (!paletteWindow || !paletteWindow.isVisible()) return;
  paletteWindow.hide();
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
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "trayTemplate@2x.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  const menu = Menu.buildFromTemplate([
    { label: "Show Codecast", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Dashboard", click: () => navigateMain("/dashboard") },
    { label: "Inbox", click: () => navigateMain("/inbox") },
    { label: "Tasks", click: () => navigateMain("/tasks") },
    { type: "separator" },
    { label: "New Session", click: () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.executeJavaScript("window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"); } },
    { label: "Command Palette", click: () => togglePalette() },
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
        { label: "Check for Updates...", click: () => autoUpdater.checkForUpdatesAndNotify() },
        { type: "separator" },
        { label: "Settings...", accelerator: "CommandOrControl+,", click: () => navigateMain("/settings") },
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
          click: () => {
            if (!mainWindow) return;
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.executeJavaScript(
              "window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"
            );
          },
        },
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
        { label: "Codecast Website", click: () => shell.openExternal("https://codecast.sh") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Install a downloaded update and relaunch.
//
// electron-updater delegates to Electron's native Squirrel.Mac, which stages
// the new bundle, registers the ShipIt launchd helper, and relies on launchd
// to run it once the app quits. On macOS 26 (Darwin 25.x) launchd accepts the
// job but never runs it: the app quits, nothing swaps the bundle, the app
// never relaunches, and the "ready to install" banner reappears (verified --
// the job sits "submitted, not running" and a manual `launchctl kickstart`
// completes the install every time).
//
// So we still call quitAndInstall() to stage + register the job, but also spawn
// a detached watcher that survives our exit. It waits ~12s for the version on
// disk to change (i.e. Squirrel's own trigger worked); if it never does, it
// force-runs the already-registered ShipIt job itself. Gating on the version
// change makes the kickstart a true fallback, so we never double-install.
let updateInstallTriggered = false;
function installUpdateAndRestart() {
  if (updateInstallTriggered) return;
  updateInstallTriggered = true;
  if (process.platform === "darwin") {
    try {
      const { spawn } = require("child_process");
      const uid = process.getuid();
      const oldVersion = app.getVersion();
      // .../Contents/MacOS/Codecast -> .../Contents/Info.plist
      const infoPlist = path.join(path.dirname(path.dirname(app.getPath("exe"))), "Info.plist");
      const script = [
        `for i in $(seq 1 24); do`,
        `  cur=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${infoPlist}" 2>/dev/null)`,
        `  if [ -n "$cur" ] && [ "$cur" != "${oldVersion}" ]; then exit 0; fi`,
        `  sleep 0.5`,
        `done`,
        `/bin/launchctl kickstart -p gui/${uid}/${SHIPIT_LABEL}`,
      ].join("\n");
      spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {
      console.error("update install fallback failed to spawn:", e?.message);
    }
  }
  autoUpdater.quitAndInstall();
}

// IPC handlers
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("set-badge-count", (_e, count) => app.setBadgeCount(count));
ipcMain.handle("get-env", () => (currentBaseUrl === PROD_URL ? "prod" : "local"));
ipcMain.handle("restart-for-update", () => installUpdateAndRestart());
ipcMain.handle("show-notification", (_e, { title, body, data }) => {
  showNativeNotification(title, body, () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (data?.conversationId) {
        const path = `/conversation/${data.conversationId}`;
        mainWindow.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('codecast-navigate', { detail: ${JSON.stringify(path)} }))`
        );
      }
    }
  });
});

// Palette IPC
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
  hidePalette();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(
      "window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"
    );
  }
});

// Settings IPC
ipcMain.handle("get-shortcuts", () => loadSettings());
ipcMain.handle("set-shortcut", (_e, key, accelerator) => {
  const shortcuts = loadSettings();
  shortcuts[key] = accelerator;
  saveSettings(shortcuts);
  registerShortcuts();
  return shortcuts;
});

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = loadSettings();

  if (shortcuts.toggleWindow) {
    globalShortcut.register(shortcuts.toggleWindow, () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  if (shortcuts.togglePalette) {
    globalShortcut.register(shortcuts.togglePalette, () => {
      togglePalette();
    });
  }

  if (shortcuts.newSession) {
    globalShortcut.register(shortcuts.newSession, () => {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.executeJavaScript(
        "window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"
      );
    });
  }

  if (shortcuts.toggleEnv) {
    globalShortcut.register(shortcuts.toggleEnv, () => toggleEnvironment());
  }
}

app.whenReady().then(() => {
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
      { label: "New Session", click: () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.executeJavaScript("window.__CODECAST_NEW_SESSION && window.__CODECAST_NEW_SESSION()"); } },
      { label: "Dashboard", click: () => navigateMain("/dashboard") },
      { label: "Inbox", click: () => navigateMain("/inbox") },
    ]));
  }
  registerShortcuts();

  // No startup notification needed -- macOS registers the app when
  // Notification.show() is first called from any code path (idle, error, etc.).

  // Auto-update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let pendingVersion;
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    mainWindow?.webContents.send("update-status", { status: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update-status", { status: "downloading", version: pendingVersion, percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-status", { status: "ready", version: info.version });
    // Notify the user instead of force-quitting. The update will also apply
    // on next app quit thanks to autoInstallOnAppQuit, so dismissing is safe.
    showNativeNotification(
      `Codecast ${info.version} is ready`,
      "Click to restart and install the update.",
      () => installUpdateAndRestart(),
    );
  });
  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err.message);
  });
  autoUpdater.checkForUpdatesAndNotify();
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

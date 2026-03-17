const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell, screen, Notification } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

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

function loadSettings() {
  try {
    const data = fs.readFileSync(getSettingsPath(), "utf8");
    return { ...DEFAULT_SHORTCUTS, ...JSON.parse(data).shortcuts };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

function saveSettings(shortcuts) {
  const settingsPath = getSettingsPath();
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  existing.shortcuts = shortcuts;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
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

function createWindow() {
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
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
    backgroundColor: "#002b36",
  });

  mainWindow.loadURL(currentBaseUrl);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
      deepLinkUrl = null;
    }
  });

  // Inject desktop detection class
  mainWindow.webContents.on("did-finish-load", () => {
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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  const menu = Menu.buildFromTemplate([
    { label: "Show Codecast", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Dashboard", click: () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.executeJavaScript("window.location.href='/dashboard'"); } },
    { label: "Inbox", click: () => { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.executeJavaScript("window.location.href='/inbox'"); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
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
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
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
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC handlers
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("set-badge-count", (_e, count) => app.setBadgeCount(count));
ipcMain.handle("get-env", () => (currentBaseUrl === PROD_URL ? "prod" : "local"));
ipcMain.handle("restart-for-update", () => autoUpdater.quitAndInstall());
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

  if (shortcuts.toggleEnv) {
    globalShortcut.register(shortcuts.toggleEnv, () => {
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
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  buildAppMenu();
  createPaletteWindow();
  registerShortcuts();

  // No startup notification needed -- macOS registers the app when
  // Notification.show() is first called from any code path (idle, error, etc.).

  // Auto-update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-status", { status: "available", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update-status", { status: "downloading", percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-status", { status: "ready", version: info.version });
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

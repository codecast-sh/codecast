const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell } = require("electron");
const path = require("path");

const PROD_URL = "https://codecast.sh";
const LOCAL_URL = "http://local.codecast.sh";
const BASE_URL = process.env.CODECAST_URL || PROD_URL;

let mainWindow = null;
let tray = null;
let deepLinkUrl = null;
let currentBaseUrl = BASE_URL;

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

app.whenReady().then(() => {
  createWindow();
  createTray();
  buildAppMenu();

  // Global shortcut: Cmd+Option+Space to toggle window
  globalShortcut.register("CommandOrControl+Alt+Space", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Global shortcut: Cmd+Ctrl+Shift+F9 to toggle local/prod
  globalShortcut.register("CommandOrControl+Shift+Alt+0", () => {
    if (!mainWindow) return;
    currentBaseUrl = currentBaseUrl === PROD_URL ? LOCAL_URL : PROD_URL;
    const env = currentBaseUrl === PROD_URL ? "prod" : "local";
    mainWindow.loadURL(currentBaseUrl);
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.executeJavaScript(
        "document.documentElement.classList.add('electron-desktop')"
      );
      mainWindow.webContents.executeJavaScript(
        `document.title = '[${env.toUpperCase()}] ' + document.title`
      );
    });
  });
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

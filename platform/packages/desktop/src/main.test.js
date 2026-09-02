// createDesktopApp against a fake Electron: proves the composition wires
// from config without a runtime, and that the parameterized names reach the
// places the donor hardcoded them. Not a behavior test of Electron itself.
const { test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDesktopApp } = require("./main");

function fakeElectron({ packaged = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-"));
  const paths = { userData, exe: "/Applications/Codecast.app/Contents/MacOS/Codecast" };
  const handlers = new Map();
  const appEvents = new Map();
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  const switches = [];
  const windows = [];
  const app = {
    name: "",
    isPackaged: packaged,
    dock: { setMenu(m) { app.dockMenu = m; } },
    commandLine: { appendSwitch: (...a) => switches.push(a) },
    getPath: (k) => paths[k],
    setPath: (k, v) => { paths[k] = v; },
    getAppPath: () => "/app",
    getVersion: () => "1.1.94",
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: (scheme) => { app.protocol = scheme; },
    on: (ev, fn) => appEvents.set(ev, fn),
    whenReady: () => ready,
    setAboutPanelOptions: (o) => { app.about = o; },
    setBadgeCount: () => {},
    quit: () => { app.quitCalled = true; },
    hide: () => {},
    focus: () => {},
    _fireReady: readyResolve,
    _events: appEvents,
  };
  class FakeWebContents {
    constructor() { this.id = Math.random(); this.sent = []; this.js = []; this.listeners = new Map(); }
    on(ev, fn) { this.listeners.set(ev, fn); }
    once(ev, fn) { this.listeners.set(ev, fn); }
    send(ch, payload) { this.sent.push([ch, payload]); }
    executeJavaScript(js) { this.js.push(js); }
    setZoomFactor() {}
    setWindowOpenHandler() {}
    isLoadingMainFrame() { return false; }
    reloadIgnoringCache() {}
    getURL() { return "https://codecast.sh/inbox"; }
    goBack() {} goForward() {}
  }
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts; this.id = windows.length + 1; this.webContents = new FakeWebContents();
      this.listeners = new Map(); this.destroyed = false; this.visible = false; this.focusedFlag = false;
      this.loaded = null; windows.push(this);
    }
    loadURL(u) { this.loaded = u; }
    on(ev, fn) { this.listeners.set(ev, fn); }
    once(ev, fn) { this.listeners.set(ev, fn); }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focusedFlag = true; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focusedFlag; }
    getBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
    getSize() { return [this.opts.width, this.opts.height]; }
    setPosition() {} destroy() { this.destroyed = true; } close() { this.destroyed = true; }
    static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
    static fromId(id) { return windows.find((w) => w.id === id) || null; }
  }
  const electron = {
    app,
    BrowserWindow,
    Menu: {
      buildFromTemplate: (t) => t,
      setApplicationMenu: (m) => { electron.appMenu = m; },
    },
    Tray: class { constructor(icon) { this.icon = icon; electron.tray = this; } setContextMenu(m) { this.menu = m; } setToolTip(t) { this.tip = t; } },
    globalShortcut: { unregisterAll() {}, register(acc) { electron.registered.push(acc); return acc !== "Bad+Key"; } },
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set(ch, fn),
    },
    nativeImage: { createFromPath: (p) => ({ p, setTemplateImage() {} }) },
    shell: { openExternal: (u) => electron.opened.push(u) },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0 } }),
    },
    Notification: class { static isSupported() { return false; } },
    session: { defaultSession: { setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} } },
    powerMonitor: { getSystemIdleTime: () => 7 },
    desktopCapturer: { getSources: async () => [] },
    handlers,
    windows,
    switches,
    registered: [],
    opened: [],
  };
  return electron;
}

const CONFIG = {
  productName: "Codecast",
  appId: "sh.codecast.desktop",
  protocol: "codecast",
  urls: { prod: "https://codecast.sh", local: "https://local.codecast.sh" },
  update: { baseUrl: "https://dl.codecast.sh/desktop", teamId: "WRG9THCK9Q" },
  assets: { icon: "/icons/icon.png", tray: "/icons/trayTemplate.png" },
  menu: {
    navItems: [{ label: "Dashboard", path: "/dashboard" }, { label: "Inbox", path: "/inbox" }],
    helpLinks: [{ label: "Documentation", url: "https://codecast.sh/documentation" }],
    settingsPath: "/settings",
  },
  palette: { path: "/palette" },
  shortcuts: { defaults: { toggleWindow: "CommandOrControl+Alt+Space", togglePalette: "Bad+Key" } },
};

test("composes windows, tray, menus, protocol and IPC from config", async () => {
  const el = fakeElectron();
  const api = createDesktopApp(CONFIG, el);
  expect(el.app.name).toBe("Codecast");
  expect(el.app.protocol).toBe("codecast");
  expect(el.switches).toEqual([["disable-features", "OverscrollHistoryNavigation"]]);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 5));

  // Main window + palette window, loading the configured URLs with the preload.
  const [main, palette] = el.windows;
  expect(main.loaded).toBe("https://codecast.sh");
  expect(palette.loaded).toBe("https://codecast.sh/palette");
  expect(main.opts.webPreferences.preload).toBe(path.join(__dirname, "preload.js"));
  expect(main.opts.webPreferences.additionalArguments).toContain("--bridge-global=__CODECAST_ELECTRON__");
  expect(main.opts.icon).toBe("/icons/icon.png");

  // Tray and menus carry the product name and the configured items.
  expect(el.tray.tip).toBe("Codecast");
  const trayLabels = el.tray.menu.map((i) => i.label).filter(Boolean);
  expect(trayLabels).toEqual(["Show Codecast", "New Session", "Quick New Session", "Command Palette", "Dashboard", "Inbox", "Check for Updates…", "Version 1.1.94", "Quit Codecast"]);
  expect(el.appMenu[0].label).toBe("Codecast");
  expect(el.appMenu[3].submenu.map((i) => i.label).filter(Boolean)).toEqual(["Dashboard", "Inbox", "Back", "Forward"]);
  expect(el.appMenu[6].submenu.map((i) => i.label).filter(Boolean)).toEqual(["Documentation", "Keyboard Shortcuts", "Check for Updates…", "Codecast Website"]);
  expect(el.app.about).toEqual({ applicationName: "Codecast", copyright: "Codecast", website: "https://codecast.sh" });

  // Shortcuts: a binding another app holds lands in issues, not a crash.
  expect(el.registered).toEqual(["CommandOrControl+Alt+Space", "Bad+Key"]);
  expect(await el.handlers.get("get-shortcut-config")()).toMatchObject({ issues: { togglePalette: "Bad+Key" } });

  // IPC surface.
  expect(await el.handlers.get("get-app-version")()).toBe("1.1.94");
  expect(await el.handlers.get("get-env")()).toBe("prod");
  expect(await el.handlers.get("get-system-idle-seconds")()).toBe(7);
  el.handlers.get("open-external")({}, "http://insecure");
  el.handlers.get("open-external")({}, "https://codecast.sh/auth/cli");
  expect(el.opened).toEqual(["https://codecast.sh/auth/cli"]);

  // Navigation dispatches the configured event into the main window.
  api.navigateMain("/inbox");
  expect(main.webContents.js.at(-1)).toBe(`window.dispatchEvent(new CustomEvent("codecast-navigate", { detail: "/inbox" }))`);
  api.openFullSessionInMain();
  expect(main.webContents.js.at(-1)).toBe(`window["__CODECAST_NEW_SESSION"] && window["__CODECAST_NEW_SESSION"]()`);

  // A deep link with the window loaded goes straight through; one that arrives
  // while the main frame is loading is held and flushed on did-finish-load.
  el.app._events.get("open-url")({ preventDefault() {} }, "codecast://open/tasks");
  expect(main.webContents.sent).toEqual([["deep-link", "codecast://open/tasks"]]);
  main.webContents.isLoadingMainFrame = () => true;
  el.app._events.get("open-url")({ preventDefault() {} }, "codecast://open/docs");
  main.webContents.listeners.get("did-finish-load")();
  expect(main.webContents.sent.filter(([ch]) => ch === "deep-link").map(([, u]) => u)).toEqual(["codecast://open/tasks", "codecast://open/docs"]);
  expect(main.webContents.js).toContain(`document.documentElement.classList.add("electron-desktop")`);

  // Notification routing: a focused window suppresses banners, duplicates collapse.
  main.focusedFlag = true;
  expect(await el.handlers.get("show-notification")({}, { title: "a", body: "b", data: { key: "k" } })).toEqual({ shown: false, reason: "focused" });
  main.focusedFlag = false;
  expect(await el.handlers.get("show-notification")({}, { title: "a", body: "b", data: { key: "k" } })).toEqual({ shown: true });
  expect(await el.handlers.get("show-notification")({}, { title: "a", body: "b", data: { key: "k" } })).toEqual({ shown: false, reason: "duplicate" });

  // Tab windows: only app-relative paths may ride detach.
  await el.handlers.get("detach-tab")({}, "https://evil.example");
  expect(el.windows.length).toBe(2);
  await el.handlers.get("detach-tab")({}, "/tasks");
  expect(el.windows.length).toBe(3);
  expect(el.windows[2].loaded).toBe("https://codecast.sh/tasks");
  expect(el.windows[2].opts.webPreferences.additionalArguments).toContain("--tab-window");

  // The updater refuses to run outside a packaged mac app, and never throws.
  expect(api.config.update.channel).toBe("latest");
});

test("a minimal config without palette, tray or local URL builds a lean shell", async () => {
  const el = fakeElectron();
  createDesktopApp({
    productName: "Whisk",
    appId: "app.whisk.desktop",
    protocol: "whisk",
    urls: { prod: "https://whisk.app" },
    update: { enabled: false },
    menu: { newSessionLabel: null },
  }, el);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 5));
  expect(el.windows.length).toBe(1);
  expect(el.tray).toBeUndefined();
  expect(el.windows[0].opts.webPreferences.additionalArguments).toContain("--bridge-global=__WHISK_ELECTRON__");
  const fileMenu = el.appMenu[1].submenu.map((i) => i.label).filter(Boolean);
  expect(fileMenu).toEqual([]);
  const windowMenu = el.appMenu[5].submenu.map((i) => i.label).filter(Boolean);
  expect(windowMenu).toEqual([]);
  expect(el.app.dockMenu).toEqual([]);
  expect(await el.handlers.get("get-env")()).toBe("prod");
});

test("env override and sticky local env pick the start URL", async () => {
  const el = fakeElectron();
  process.env.CODECAST_URL = "https://override.example";
  try {
    createDesktopApp(CONFIG, el);
  } finally {
    delete process.env.CODECAST_URL;
  }
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 5));
  expect(el.windows[0].loaded).toBe("https://override.example");

  const el2 = fakeElectron();
  fs.writeFileSync(path.join(el2.app.getPath("userData"), "settings.json"), JSON.stringify({ env: "local" }));
  createDesktopApp(CONFIG, el2);
  el2.app._fireReady();
  await new Promise((r) => setTimeout(r, 5));
  expect(el2.windows[0].loaded).toBe("https://local.codecast.sh");
  expect(await el2.handlers.get("get-env")()).toBe("local");
});

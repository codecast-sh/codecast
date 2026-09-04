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
    defaults: new Set(),
    setAsDefaultProtocolClient: (scheme) => { app.protocol = scheme; app.defaults.add(scheme); },
    isDefaultProtocolClient: (scheme) => app.defaults.has(scheme),
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
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
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
    loadFile(f) { this.loaded = "file:" + f; }
    static getAllWindows() { return windows.filter((w) => !w.destroyed); }
    on(ev, fn) { this.listeners.set(ev, fn); }
    once(ev, fn) { this.listeners.set(ev, fn); }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focusedFlag = true; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focusedFlag; }
    getBounds() { return { x: 0, y: 0, width: 10, height: 10 }; }
    getNormalBounds() { return { x: 5, y: 6, width: 1111, height: 777 }; }
    isMinimized() { return false; } isFullScreen() { return false; }
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
    protocol: { handle: (scheme, fn) => electron.protocols.set(scheme, fn) },
    net: { fetch: (...a) => electron.netFetch(...a) },
    netFetch: async () => { throw new TypeError("no network in this test"); },
    protocols: new Map(),
    screen: {
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
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

// ── The offline copy, extra schemes, bounds, hooks ──────────────────────────
const { sha256, releaseIdFor } = require("./webCache");

function fakeSite(files) {
  const hashes = {};
  for (const [f, c] of Object.entries(files)) hashes[f] = sha256(Buffer.from(c));
  const manifest = { release: releaseIdFor(hashes), commit: "c", files: hashes };
  return {
    manifest,
    offline: false,
    async fetch(input, opts) {
      const url = typeof input === "string" ? input : input.url;
      if (this.offline) throw new TypeError("fetch failed");
      // The copy's own downloads must carry the bypass flag.
      if (typeof input === "string") expect(opts.bypassCustomProtocolHandlers).toBe(true);
      const p = decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
      if (p === "release.json") return new Response(JSON.stringify(manifest));
      if (p in files) return new Response(files[p]);
      return new Response("nope", { status: 404 });
    },
  };
}

const WHISK = {
  productName: "Whisk",
  appId: "email.whisk.desktop",
  protocol: "whisk",
  urls: { prod: "https://whisk.email" },
  update: { enabled: false },
  menu: { newSessionLabel: null },
  web: { cache: true, startupTimeoutMs: 2000, checkIntervalMs: 60_000 },
  extraProtocols: [{ scheme: "mailto", name: "Email address", claimOnFirstRun: true, menuLabel: "Make Whisk the Default Mail App" }],
  downloadUrls: (url) => url.includes("/gmail/attachment"),
};

test("the offline copy gates the launch on a manifest check, serves the app host, and reports a later release", async () => {
  const el = fakeElectron();
  let site = fakeSite({ "index.html": "<html>v1</html>", "assets/a.js": "1" });
  el.netFetch = (...a) => site.fetch(...a);
  let readyApi = null;
  createDesktopApp({ ...WHISK, hooks: { onReady: (api) => { readyApi = api; } } }, el);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 30));

  // Both schemes intercepted; the window loaded after the copy was filled.
  expect([...el.protocols.keys()].sort()).toEqual(["http", "https"]);
  const main = el.windows[0];
  expect(main.loaded).toBe("https://whisk.email");
  const v1 = site.manifest.release;
  expect(await el.handlers.get("get-web-release")()).toMatchObject({ release: v1 });
  expect(readyApi.webRelease().release).toBe(v1);
  main.webContents.listeners.get("did-finish-load")();

  // The handler answers the app host from the copy and passes the rest through.
  const res = await el.protocols.get("https")(new Request("https://whisk.email/"));
  expect(await res.text()).toBe("<html>v1</html>");
  const third = await el.protocols.get("https")(new Request("https://other.example/x"));
  expect(third.status).toBe(404);

  // A newer release lands: the page hears about it, and the copy serves it.
  site = fakeSite({ "index.html": "<html>v2</html>", "assets/b.js": "2" });
  const r = await el.handlers.get("refresh-web")();
  expect(r).toMatchObject({ status: "updated", from: v1 });
  expect(main.webContents.sent).toContainEqual(["web-update", { release: site.manifest.release, from: v1 }]);
  expect(await (await el.protocols.get("https")(new Request("https://whisk.email/"))).text()).toBe("<html>v2</html>");

  // Offline: the copy stays and the refresh says so.
  site.offline = true;
  expect((await el.handlers.get("refresh-web")()).status).toBe("offline");
  expect(await (await el.protocols.get("https")(new Request("https://whisk.email/assets/b.js"))).text()).toBe("2");

  // Downloads named by config are saved in-app, other pages go to the browser.
  const handler = main.webContents.windowOpenHandler;
  main.webContents.downloadURL = (u) => main.webContents.downloaded = u;
  expect(handler({ url: "https://x.convex.site/gmail/attachment?id=1" })).toEqual({ action: "deny" });
  expect(main.webContents.downloaded).toBe("https://x.convex.site/gmail/attachment?id=1");
  handler({ url: "https://example.com/page" });
  expect(el.opened).toEqual(["https://example.com/page"]);
});

test("an offline first launch still opens: the load waits only startupTimeoutMs", async () => {
  const el = fakeElectron();
  const t0 = Date.now();
  createDesktopApp({ ...WHISK, web: { cache: true, startupTimeoutMs: 50 } }, el);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 30));
  expect(el.windows[0].loaded).toBe("https://whisk.email");
  expect(Date.now() - t0).toBeLessThan(200);
  expect(await el.handlers.get("get-web-release")()).toBeNull();
  const res = await el.protocols.get("https")(new Request("https://whisk.email/", { headers: { "sec-fetch-dest": "document" } }));
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("Whisk needs a connection");
});

test("extra schemes: claimed once on the first packaged launch, offered in the menu, delivered like deep links", async () => {
  const el = fakeElectron();
  createDesktopApp(WHISK, el);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 10));
  expect([...el.app.defaults].sort()).toEqual(["mailto", "whisk"]);
  expect(el.appMenu[0].submenu.map((i) => i.label).filter(Boolean)).toContain("Make Whisk the Default Mail App");
  expect(fs.existsSync(path.join(el.app.getPath("userData"), "first-run-done"))).toBe(true);

  // A second launch on the same profile does not ask again.
  el.app.defaults.clear();
  const again = fakeElectron();
  again.app.getPath = el.app.getPath;
  createDesktopApp(WHISK, again);
  again.app._fireReady();
  await new Promise((r) => setTimeout(r, 10));
  expect([...again.app.defaults]).toEqual(["whisk"]);
  // …until asked to, from the menu or the page.
  expect(await again.handlers.get("set-default-client")({}, "mailto")).toBe(true);
  expect(await again.handlers.get("is-default-client")({}, "mailto")).toBe(true);
  expect(await again.handlers.get("set-default-client")({}, "https")).toBe(false);

  // mailto: arrives through the deep link channel, from argv and from open-url.
  const main = again.windows[0];
  again.app._events.get("second-instance")({}, ["/Applications/Whisk.app", "mailto:ada@example.com?subject=hi"]);
  again.app._events.get("open-url")({ preventDefault() {} }, "whisk://app#token=abc");
  expect(main.webContents.sent.filter(([ch]) => ch === "deep-link").map(([, u]) => u)).toEqual(["mailto:ada@example.com?subject=hi", "whisk://app#token=abc"]);
});

test("window bounds persist and come back only when they land on a display", async () => {
  const el = fakeElectron();
  const settings = path.join(el.app.getPath("userData"), "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ bounds: { x: 100, y: 120, width: 1000, height: 700 } }));
  createDesktopApp({ ...WHISK, web: { cache: false } }, el);
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 10));
  expect(el.windows[0].opts).toMatchObject({ x: 100, y: 120, width: 1000, height: 700 });

  // A resize is saved (debounced) from the window's normal bounds.
  el.windows[0].listeners.get("resize")();
  await new Promise((r) => setTimeout(r, 350));
  expect(JSON.parse(fs.readFileSync(settings, "utf8")).bounds).toEqual({ x: 5, y: 6, width: 1111, height: 777 });

  const el2 = fakeElectron();
  fs.writeFileSync(path.join(el2.app.getPath("userData"), "settings.json"), JSON.stringify({ bounds: { x: 99999, y: 99999, width: 1000, height: 700 } }));
  createDesktopApp({ ...WHISK, web: { cache: false } }, el2);
  el2.app._fireReady();
  await new Promise((r) => setTimeout(r, 10));
  expect(el2.windows[0].opts.x).toBeUndefined();
  expect(el2.windows[0].opts).toMatchObject({ width: 1000, height: 700 });
});

test("app defined ipc handlers, events, menu items and windows", async () => {
  const el = fakeElectron();
  const seen = [];
  const api = createDesktopApp(
    {
      ...CONFIG,
      ipc: { handlers: { permissions: (kind, shellApi) => ({ kind, hasApi: typeof shellApi.emit === "function" }) }, events: ["permissions-changed"] },
      menu: { ...CONFIG.menu, appItems: [{ label: "Mac Setup…", action: (a) => seen.push(a === api) }] },
    },
    el,
  );
  el.app._fireReady();
  await new Promise((r) => setTimeout(r, 5));
  // The handler is registered under the app: prefix and receives the API last.
  expect(await el.handlers.get("app:permissions")({}, "fda")).toEqual({ kind: "fda", hasApi: true });
  // The menu item is in the application menu and its action gets the API.
  const appMenu = el.appMenu[0].submenu.find((i) => i.label === "Mac Setup…");
  appMenu.click();
  expect(seen).toEqual([true]);
  // An app window on the preload, loading a file, reachable by emit.
  const win = api.openWindow({ file: "/app/setup.html", width: 640 });
  expect(win.loaded).toBe("file:/app/setup.html");
  expect(win.opts.webPreferences.additionalArguments).toContain("--bridge-global=__CODECAST_ELECTRON__");
  api.emit("permissions-changed", { fda: "granted" });
  expect(win.webContents.sent).toContainEqual(["app:permissions-changed", { fda: "granted" }]);
  expect(() => api.emit("not-listed", 1)).toThrow(/ipc.events/);
});

// Run: node --test packages/electron/installedApps/electronHost.test.js
//
// The Electron-window host against a recording stand-in for Electron: the
// navigation lock, who the bridge answers, the frame version read from the
// response header, the partition's user agent, and the Windows identity.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createElectronHost,
  pageUrlAllowed,
  externalAllowed,
  castVersionHeader,
  shortcutFileName,
  shortcutPathFor,
  windowsToastScript,
  toastLaunchUrl,
  windowsToast,
  signedOutCoverUrl,
  OPEN_CODECAST,
  popoverPosition,
  trayAnchor,
} = require("./electronHost");

const ORIGIN = "https://a.codecast.sh";
const SLUG = "k3j2h4ab";

function fakeElectron() {
  let nextId = 1;
  const windows = [];
  const sessions = new Map();
  const handlers = new Map();
  const external = [];
  const shortcuts = new Map();
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.calls = [];
      this.destroyed = false;
      this.visible = false;
      const wc = new EventEmitter();
      wc.id = nextId++;
      wc.sent = [];
      wc.send = (ch, payload) => wc.sent.push([ch, payload]);
      wc.mainFrame = { url: "about:blank" };
      wc.setWindowOpenHandler = (fn) => (wc.openHandler = fn);
      wc.isLoading = () => false;
      wc.isDevToolsOpened = () => false;
      this.webContents = wc;
      windows.push(this);
    }
    record(name, ...args) { this.calls.push([name, ...args]); }
    loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; this.record("loadURL", url); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() { this.emit("close"); this.destroy(); }
    show() { this.visible = true; this.record("show"); }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    focus() { this.record("focus"); }
    isMinimized() { return false; }
    restore() {}
    getBounds() { return { x: 10, y: 20, width: this.options.width, height: this.options.height }; }
    getNormalBounds() { return this.getBounds(); }
    getSize() { return [this.options.width, this.options.height]; }
    setPosition(x, y) { this.record("setPosition", x, y); }
    setAppDetails(d) { this.record("setAppDetails", d); }
    setTitle(t) { this.record("setTitle", t); }
    setContentSize(w, h) { this.record("setContentSize", w, h); }
    setAlwaysOnTop(...a) { this.record("setAlwaysOnTop", ...a); }
    setIgnoreMouseEvents(...a) { this.record("setIgnoreMouseEvents", ...a); }
    setOverlayIcon(...a) { this.record("setOverlayIcon", ...a); }
  }
  const session = {
    fromPartition(name) {
      if (!sessions.has(name)) {
        sessions.set(name, {
          ua: "Mozilla/5.0 Electron/44",
          getUserAgent() { return this.ua; },
          setUserAgent(ua) { this.ua = ua; },
          webRequest: { onHeadersReceived(fn) { this.listener = fn; } },
          setPermissionRequestHandler(fn) { this.requestHandler = fn; },
          setPermissionCheckHandler(fn) { this.checkHandler = fn; },
          cleared: 0,
          async clearStorageData() { this.cleared++; },
          async clearCache() {},
        });
      }
      return sessions.get(name);
    },
  };
  const electron = {
    BrowserWindow: FakeWindow,
    session,
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    Tray: class extends EventEmitter {
      constructor(image) { super(); this.image = image; this.destroyed = false; electron.Tray.last = this; }
      setToolTip(t) { this.tooltip = t; }
      setTitle(t) { this.title = t; }
      getBounds() { return { x: 1200, y: 0, width: 22, height: 22 }; }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; }
    },
    nativeImage: {
      createFromPath: (p) => ({ path: p, setTemplateImage(v) { this.template = v; }, resize() { return this; } }),
      createEmpty: () => ({ empty: true, setTemplateImage() {} }),
      createFromBitmap: () => ({ badge: true }),
    },
    globalShortcut: {
      register: (acc, cb) => (shortcuts.has(acc) ? false : (shortcuts.set(acc, cb), true)),
      isRegistered: (acc) => shortcuts.has(acc),
      unregister: (acc) => shortcuts.delete(acc),
    },
    shell: { openExternal: (u) => external.push(u), writeShortcutLink: (p, op, o) => (external.push(["lnk", p, op, o]), true) },
    screen: {
      getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 25, width: 1600, height: 975 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    },
    app: { isPackaged: true, getAppPath: () => "/app", getPath: (n) => (n === "exe" ? "C:\\Users\\a\\AppData\\Local\\Programs\\Codecast\\Codecast.exe" : "C:\\Users\\a\\AppData\\Roaming") },
    powerMonitor: new EventEmitter(),
  };
  return { electron, windows, sessions, handlers, external, shortcuts };
}

function rig({ platform = "darwin", record = {}, extra = {} } = {}) {
  const fake = fakeElectron();
  const records = { [SLUG]: { slug: SLUG, name: "Vitals", grants: [], facts: { version: 7, app: { window: { width: 420, height: 640, minWidth: 320, minHeight: 400, resizable: true, titleBar: "default" }, tray: { width: 360, height: 480, tooltip: "Vitals" } } }, ...record } };
  const calls = [];
  const events = { focus: [], closed: [] };
  const host = createElectronHost({
    electron: fake.electron,
    registry: { get: (s) => records[s] || null, list: () => Object.values(records), update: (s, p) => Object.assign(records[s], p) },
    pageOrigin: ORIGIN,
    pageUrl: (slug, surface) => `${ORIGIN}/${slug}?host=app&surface=${surface}`,
    call: async (slug, frame, msg) => (calls.push({ slug, frame, msg }), { id: msg.id, ok: true, value: "ran" }),
    onFocus: (s) => events.focus.push(s),
    onClosed: (s) => events.closed.push(s),
    appVersion: "1.2.3",
    platform,
    log: () => {},
    ...extra,
  });
  return { ...fake, host, records, calls, events };
}

const navEvent = (url, isMainFrame = true) => ({ url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } });

test("the lock admits the page and paths under it on the page origin, nothing else", () => {
  const o = [ORIGIN];
  assert.ok(pageUrlAllowed(`${ORIGIN}/${SLUG}`, SLUG, o));
  assert.ok(pageUrlAllowed(`${ORIGIN}/${SLUG}?host=app&surface=tray`, SLUG, o));
  assert.ok(pageUrlAllowed(`${ORIGIN}/${SLUG}/sub/page.html#x`, SLUG, o));
  for (const bad of [`${ORIGIN}/${SLUG}x`, `${ORIGIN}/other123`, `${ORIGIN}/`, `http://a.codecast.sh/${SLUG}`, `https://evil.sh/${SLUG}`, `https://u:p@a.codecast.sh/${SLUG}`, `file:///${SLUG}`, `${ORIGIN}/${SLUG}/../other123`, `${ORIGIN}/${SLUG}/%2e%2e/other123`, `${ORIGIN}/${SLUG}/.%2E/other123`, `data:text/html,x`, `blob:${ORIGIN}/${SLUG}/1`, "about:blank", "not a url", null]) {
    assert.ok(!pageUrlAllowed(bad, SLUG, o), String(bad));
  }
  for (const okUrl of ["https://x.com", "http://x.com/a", "mailto:a@b.c"]) assert.ok(externalAllowed(okUrl), okUrl);
  for (const bad of ["file:///etc/passwd", "ssh://host", "smb://share", "vnc://h", "x-apple.systempreferences:com.apple", "javascript:alert(1)", "zoommtg://x"]) assert.ok(!externalAllowed(bad), bad);
});

test("an app window is sandboxed in its own partition with the app preload, and its user agent names the app", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const win = r.windows[0];
  const prefs = win.options.webPreferences;
  assert.equal(prefs.partition, `persist:app-${SLUG}`);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.match(prefs.preload, /installedApps[\\/]appPreload\.js$/);
  assert.equal(win.options.width, 420);
  assert.equal(win.options.minHeight, 400);
  assert.equal(win.url, `${ORIGIN}/${SLUG}?host=app&surface=window`);
  const ses = r.sessions.get(`persist:app-${SLUG}`);
  assert.equal(ses.ua, `Mozilla/5.0 Electron/44 CodecastApp/1.2.3 (${SLUG})`);
  // Web permissions: the page cannot reach native notifications around cast.app.notify.
  let granted = null;
  ses.requestHandler(win.webContents, "notifications", (v) => (granted = v));
  assert.equal(granted, false);
  ses.requestHandler(win.webContents, "clipboard-sanitized-write", (v) => (granted = v));
  assert.equal(granted, true);
  // Opening again focuses the same window.
  await r.host.open(SLUG);
  assert.equal(r.windows.length, 1);
  assert.ok(r.host.isOpen(SLUG));
});

test("navigation off the page goes to the default browser for http, https and mailto, and nowhere for anything else", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const wc = r.windows[0].webContents;
  const stay = navEvent(`${ORIGIN}/${SLUG}/next`);
  wc.emit("will-frame-navigate", stay);
  assert.equal(stay.prevented, false);
  const leave = navEvent("https://example.com/");
  wc.emit("will-frame-navigate", leave);
  assert.equal(leave.prevented, true);
  wc.emit("will-navigate", leave, "https://example.com/"); // the same navigation, heard twice, opens once
  const other = navEvent(`${ORIGIN}/other123`);
  wc.emit("will-frame-navigate", other);
  assert.equal(other.prevented, true);
  const file = navEvent("file:///etc/passwd");
  wc.emit("will-frame-navigate", file);
  assert.equal(file.prevented, true);
  const sub = navEvent("https://player.example/embed", false);
  wc.emit("will-frame-navigate", sub);
  assert.equal(sub.prevented, false, "frames inside the page are the page's business");
  const redirect = navEvent("https://evil.example/");
  wc.emit("will-redirect", redirect, "https://evil.example/", false, true);
  assert.equal(redirect.prevented, true);
  assert.deepEqual(wc.openHandler({ url: "mailto:a@b.c" }), { action: "deny" });
  assert.deepEqual(wc.openHandler({ url: "vnc://host" }), { action: "deny" });
  assert.deepEqual(r.external, ["https://example.com/", `${ORIGIN}/other123`, "https://evil.example/", "mailto:a@b.c"]);
});

test("the bridge answers only the app's main frame on its page, with the version its response carried", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const wc = r.windows[0].webContents;
  const handle = r.handlers.get("cast-app:call");
  const ses = r.sessions.get(`persist:app-${SLUG}`);
  const headers = (h) => new Promise((resolve) => ses.webRequest.listener({ resourceType: "mainFrame", webContentsId: wc.id, url: `${ORIGIN}/${SLUG}?host=app`, responseHeaders: h }, resolve));
  await headers({ "X-Cast-Version": ["9"] });
  const msg = { id: "c1", module: "app", method: "info", args: [] };
  const reply = await handle({ sender: wc, senderFrame: wc.mainFrame }, msg);
  assert.deepEqual(reply, { id: "c1", ok: true, value: "ran" });
  assert.deepEqual(r.calls[0], { slug: SLUG, frame: { version: 9, surface: "window" }, msg });
  // A subframe, a page that navigated off the slug, and an unknown sender are refused.
  const sub = await handle({ sender: wc, senderFrame: { url: `${ORIGIN}/${SLUG}` } }, msg);
  assert.equal(sub.ok, false);
  wc.mainFrame.url = `${ORIGIN}/other123`;
  assert.equal((await handle({ sender: wc, senderFrame: wc.mainFrame }, msg)).ok, false);
  const stranger = { id: 999, mainFrame: { url: `${ORIGIN}/${SLUG}` } };
  assert.equal((await handle({ sender: stranger, senderFrame: stranger.mainFrame }, msg)).ok, false);
  assert.equal(r.calls.length, 1);
  wc.mainFrame.url = `${ORIGIN}/${SLUG}`;
  // A response without the header counts as the version the facts named at load.
  await headers({});
  await handle({ sender: wc, senderFrame: wc.mainFrame }, msg);
  assert.equal(r.calls[1].frame.version, 7);
  // Other resources never move the frame version.
  await new Promise((resolve) => ses.webRequest.listener({ resourceType: "script", webContentsId: wc.id, url: `${ORIGIN}/${SLUG}/a.js`, responseHeaders: { "x-cast-version": "12" } }, resolve));
  await handle({ sender: wc, senderFrame: wc.mainFrame }, msg);
  assert.equal(r.calls[2].frame.version, 7);
});

test("X-Cast-Version is read whatever its case, and only as a positive integer", () => {
  assert.equal(castVersionHeader({ "x-cast-version": ["4"] }), 4);
  assert.equal(castVersionHeader({ "X-CAST-VERSION": "12" }), 12);
  assert.equal(castVersionHeader({ "x-cast-version": "abc" }), null);
  assert.equal(castVersionHeader({ "x-cast-version": "0" }), null);
  assert.equal(castVersionHeader({}), null);
});

test("host events reach every open surface of the app", async () => {
  const r = rig();
  await r.host.open(SLUG);
  r.host.emit(SLUG, "version", { version: 8 });
  assert.deepEqual(r.windows[0].webContents.sent, [["cast-app:event", { event: "version", data: { version: 8 } }]]);
  r.host.reload(SLUG);
  assert.equal(r.windows[0].calls.filter((c) => c[0] === "loadURL").length, 2);
});

test("tray: an item with the app's tooltip, and a popover at surface=tray anchored to it", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const ctx = { slug: SLUG, frame: { surface: "window" } };
  r.host["tray.set"](ctx, { title: "3", badge: 2 });
  r.host["tray.set"](ctx, { tooltip: "Vitals now" });
  const tray = r.electron.Tray.last;
  assert.equal(tray.tooltip, "Vitals now");
  assert.equal(tray.title, "3 2");
  const before = r.windows.length;
  tray.emit("click");
  const pop = r.windows[before];
  assert.equal(pop.url, `${ORIGIN}/${SLUG}?host=app&surface=tray`);
  assert.equal(pop.options.frame, false);
  assert.equal(pop.options.width, 360);
  assert.deepEqual(pop.calls.find((c) => c[0] === "setPosition"), ["setPosition", 1031, 26]);
  assert.ok(pop.visible);
  assert.deepEqual(r.windows[0].webContents.sent.at(-1), ["cast-app:event", { event: "tray-click", data: {} }]);
  // A second click closes it; open(slug, {surface: "tray"}) shows it again.
  tray.emit("click");
  assert.ok(!pop.visible);
  await r.host.open(SLUG, { surface: "tray" });
  assert.ok(pop.visible);
  r.host["tray.remove"](ctx);
  assert.ok(tray.destroyed);
  assert.ok(pop.destroyed);
});

test("global shortcuts fire to the app, not while the screen is locked, and one app cannot take another's", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const ctx = { slug: SLUG, frame: { surface: "window" } };
  r.host["shortcuts.register"](ctx, "CmdOrCtrl+Shift+K");
  r.shortcuts.get("CmdOrCtrl+Shift+K")();
  assert.deepEqual(r.windows[0].webContents.sent.at(-1), ["cast-app:event", { event: "shortcut", data: { accelerator: "CmdOrCtrl+Shift+K" } }]);
  r.electron.powerMonitor.emit("lock-screen");
  const before = r.windows[0].webContents.sent.length;
  r.shortcuts.get("CmdOrCtrl+Shift+K")();
  assert.equal(r.windows[0].webContents.sent.length, before);
  r.electron.powerMonitor.emit("unlock-screen");
  r.shortcuts.set("Alt+Shift+P", () => {});
  assert.throws(() => r.host["shortcuts.register"](ctx, "Alt+Shift+P"), (e) => e.code === "failed");
  // main.js's own rebinding unregisters everything; the app's come back.
  r.shortcuts.clear();
  r.host.reregisterShortcuts();
  assert.ok(r.shortcuts.has("CmdOrCtrl+Shift+K"));
  r.host["shortcuts.unregister"](ctx, "CmdOrCtrl+Shift+K");
  assert.ok(!r.shortcuts.has("CmdOrCtrl+Shift+K"));
});

test("window calls act on the calling surface; click-through ends when the window is focused", async () => {
  const r = rig();
  await r.host.open(SLUG);
  const win = r.windows[0];
  const ctx = { slug: SLUG, frame: { surface: "window" } };
  r.host["window.setTitle"](ctx, "Vitals: 3");
  r.host["window.setSize"](ctx, 500.4, 300);
  r.host["window.setAlwaysOnTop"](ctx, true);
  r.host["window.setIgnoreMouseEvents"](ctx, true);
  win.emit("focus");
  assert.deepEqual(win.calls.filter((c) => c[0] !== "loadURL"), [
    ["setTitle", "Vitals: 3"],
    ["setContentSize", 500, 300],
    ["setAlwaysOnTop", true, "floating"],
    ["setIgnoreMouseEvents", true, { forward: true }],
    ["setIgnoreMouseEvents", false],
  ]);
  assert.deepEqual(r.events.focus, [SLUG]);
  assert.throws(() => r.host["window.focus"]({ slug: SLUG, frame: { surface: "tray" } }), (e) => e.code === "failed");
  win.close();
  assert.deepEqual(r.records[SLUG].bounds, { x: 10, y: 20, width: 420, height: 640 }, "bounds persist per app");
  assert.deepEqual(r.events.closed, [SLUG]);
  assert.ok(!r.host.isOpen(SLUG));
});

test("Windows: own taskbar identity, a Start menu shortcut carrying the AUMID, an overlay badge", async () => {
  const r = rig({ platform: "win32", record: { icons: { ico: __filename } } });
  await r.host.open(SLUG);
  const win = r.windows[0];
  const details = win.calls.find((c) => c[0] === "setAppDetails")[1];
  assert.equal(details.appId, `Codecast.App.${SLUG}`);
  assert.equal(details.appIconPath, __filename);
  assert.equal(details.relaunchCommand, `"C:\\Users\\a\\AppData\\Local\\Programs\\Codecast\\Codecast.exe" "--codecast-app=${SLUG}"`);
  assert.equal(details.relaunchDisplayName, "Vitals");
  r.host["app.badge"]({ slug: SLUG }, 3);
  assert.deepEqual(win.calls.at(-1), ["setOverlayIcon", { badge: true }, "3"]);
  r.host["app.badge"]({ slug: SLUG }, 0);
  assert.deepEqual(win.calls.at(-1), ["setOverlayIcon", null, ""]);
});

test("a Start menu file name keeps the display name and drops what Windows forbids", () => {
  assert.equal(shortcutFileName("Vitals"), "Vitals.lnk");
  assert.equal(shortcutFileName('A/B: "c"?'), "A-B- -c--.lnk");
  assert.equal(shortcutFileName("..."), "App.lnk");
  assert.equal(shortcutFileName("Café 東京"), "Café 東京.lnk");
  assert.equal(shortcutFileName(`${"a".repeat(79)}. tail`), `${"a".repeat(79)}.lnk`, "no trailing dot after the cut");
  for (const name of ["CON", "con", "Nul", "COM1", "lpt9", "aux.notes"]) assert.notEqual(shortcutFileName(name).split(".")[0].toLowerCase(), name.split(".")[0].toLowerCase(), name);
  assert.equal(shortcutFileName("Console"), "Console.lnk");
  assert.equal(shortcutFileName("Notes", "k3j2h4ab"), "Notes (k3j2h4ab).lnk");
});

test("two apps of one name get two Start menu shortcuts", () => {
  const dir = "C:\\Users\\a\\Start Menu\\Codecast Apps";
  const first = { slug: "aaaa1111", name: "Notes", shortcutPath: `${dir}/notes.lnk` };
  assert.equal(shortcutPathFor(dir, { slug: "bbbb2222", name: "Notes" }, [first]).endsWith("Notes (bbbb2222).lnk"), true, "case-insensitive clash");
  assert.equal(shortcutPathFor(dir, { slug: "aaaa1111", name: "Notes" }, [first]).endsWith("Notes.lnk"), true, "its own file is not a clash");
  assert.equal(shortcutPathFor(dir, { slug: "bbbb2222", name: "Todo" }, [first]).endsWith("Todo.lnk"), true);
});

test("Windows install writes the shortcut beside another app's of the same name, not over it", async () => {
  const r = rig({ platform: "win32", record: { name: "Notes" } });
  r.records.other123 = { slug: "other123", name: "Notes", shortcutPath: "C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Codecast Apps\\Notes.lnk" };
  const fs = require("node:fs");
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = () => {};
  try {
    const { shortcutPath } = await r.host.install({ record: r.records[SLUG], icons: null });
    assert.match(shortcutPath, new RegExp(`Notes \\(${SLUG}\\)\\.lnk$`));
    const lnk = r.external.find((e) => Array.isArray(e) && e[0] === "lnk");
    assert.equal(lnk[3].appUserModelId, `Codecast.App.${SLUG}`);
  } finally {
    fs.mkdirSync = mkdir;
  }
});

test("open at login quotes the args and leaves the exe for Electron to quote", async () => {
  const r = rig({ platform: "win32" });
  const set = [];
  r.electron.app.setLoginItemSettings = (o) => set.push(o);
  r.electron.app.isPackaged = false;
  r.electron.app.getAppPath = () => "C:\\Users\\Jane Doe\\src\\codecast\\packages\\electron";
  const dev = createElectronHost({ electron: r.electron, registry: { get: () => r.records[SLUG], list: () => [], update() {} }, pageOrigin: ORIGIN, pageUrl: () => "", call: async () => ({}), appVersion: "1", platform: "win32", log: () => {} });
  dev["login.set"]({ slug: SLUG }, true);
  assert.deepEqual(set[0], { openAtLogin: true, args: ['"C:\\Users\\Jane Doe\\src\\codecast\\packages\\electron"', `--codecast-app=${SLUG}`], name: `CodecastApp-${SLUG}` });
  assert.equal("path" in set[0], false);
});

test("the toast script quotes everything it carries and shows through the app's AUMID", () => {
  const script = windowsToastScript({ appId: `Codecast.App.${SLUG}`, title: "It's <done>", body: "a & b", tag: "t'1", silent: true });
  assert.match(script, /CreateToastNotifier\('Codecast\.App\.k3j2h4ab'\)/);
  assert.match(script, /It&apos;s &lt;done&gt;/, "XML-escaped, so no quote reaches PowerShell");
  assert.match(script, /a &amp; b/);
  assert.match(script, /\$toast\.Tag = 't''1'/);
  assert.match(script, /<audio silent="true"\/>/);
});

test("a toast is a protocol toast that opens the app's click link, and the script only shows it", () => {
  const script = windowsToastScript({ appId: `Codecast.App.${SLUG}`, slug: SLUG, title: "t", tag: "eg-1 & 2" });
  assert.match(script, new RegExp(`<toast activationType="protocol" launch="codecast://app-notification/${SLUG}\\?tag=eg-1%20%26%202">`));
  assert.doesNotMatch(script, /Register-ObjectEvent|Wait-Event/, "Windows PowerShell 5.1 cannot subscribe to WinRT events");
  assert.equal(toastLaunchUrl(SLUG, null), `codecast://app-notification/${SLUG}`);
  const { notificationClickFromUrl } = require("./host");
  assert.deepEqual(notificationClickFromUrl(toastLaunchUrl(SLUG, "eg-1 & 2")), { slug: SLUG, tag: "eg-1 & 2" });
  assert.deepEqual(notificationClickFromUrl(toastLaunchUrl(SLUG, null)), { slug: SLUG, tag: null });
  assert.equal(notificationClickFromUrl("codecast://app-notification/abc/def"), null, "one plain slug, nothing nested");
  assert.equal(notificationClickFromUrl("codecast://uninstall/abc"), null);
  assert.equal(notificationClickFromUrl(`codecast://app-notification/${SLUG}?tag=%E0%A4%A`).slug, SLUG, "a malformed escape never throws");
});

test("a curly quote in a toast's text cannot end the PowerShell literal it rides in", () => {
  // PowerShell reads U+2018 to U+201B as single quotes; undoubled, this title ran its own command.
  const script = windowsToastScript({ appId: "a", title: "Bob\u2019; Write-Output INJECTED; \u2018", tag: "x\u201by" });
  const load = script.split("\n").find((l) => l.startsWith("$xml.LoadXml("));
  assert.match(load, /Bob\u2019\u2019; Write-Output INJECTED; \u2018\u2018/);
  assert.match(script, /\$toast\.Tag = 'x\u201b\u201by'/);
});

test("toast text drops what XML refuses and is capped, so the toast still shows", () => {
  const script = windowsToastScript({ appId: "a", title: "a\u0001b\ud800c\u0009", body: "x".repeat(50_000) });
  assert.match(script, /<text>abc\t<\/text>/);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  assert.ok(encoded.length < 30_000, `encoded script is ${encoded.length} characters`);
  const emoji = windowsToastScript({ appId: "a", title: "\u{1F600}".repeat(300) });
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/, "never cut inside a surrogate pair");
  const tagLine = (tag) => windowsToastScript({ appId: "a", title: "t", tag }).split("\n").find((l) => l.startsWith("$toast.Tag"));
  assert.equal(tagLine(`${"a".repeat(63)}\u{1F600}tail`), `$toast.Tag = '${"a".repeat(63)}\u{1F600}'`, "the tag is cut between code points");
  assert.equal(tagLine("x\u0000y\u0007"), "$toast.Tag = 'xy'", "and loses what XML refuses");
  assert.equal(tagLine("\u0001"), undefined, "a tag with nothing left is not set");
});

test("the popover sits under a top tray and over a bottom one, inside the display", () => {
  const area = { x: 0, y: 0, width: 1600, height: 1000 };
  assert.deepEqual(popoverPosition({ x: 1200, y: 0, width: 22, height: 22 }, { width: 360, height: 480 }, area), { x: 1031, y: 26 });
  assert.deepEqual(popoverPosition({ x: 1580, y: 970, width: 20, height: 30 }, { width: 360, height: 480 }, area), { x: 1240, y: 486 });
});

test("a tray item hidden off the display hangs its popover from the display's tray corner", () => {
  const display = { bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 25, width: 1600, height: 935 } };
  const shown = { x: 1200, y: 0, width: 22, height: 25 };
  assert.deepEqual(trayAnchor(shown, display, "darwin"), shown);
  assert.deepEqual(trayAnchor({ x: 0, y: 0, width: 0, height: 0 }, display, "darwin"), { x: 1560, y: 0, width: 24, height: 25 });
  assert.deepEqual(trayAnchor({ x: -3000, y: 5000, width: 22, height: 25 }, display, "win32"), { x: 1560, y: 960, width: 24, height: 40 });
  const mac = popoverPosition(trayAnchor(null, display, "darwin"), { width: 320, height: 260 }, display.workArea);
  assert.deepEqual(mac, { x: 1280, y: 29 });
});

test("signed out, a surface shows the cover instead of the page, and comes back when signed in", async () => {
  let signedIn = false;
  const opened = [];
  const r = rig({ extra: { signedIn: () => signedIn, openInCodecast: (slug) => opened.push(slug) } });
  await r.host.open(SLUG);
  const win = r.windows[0];
  assert.equal(win.url, signedOutCoverUrl("Vitals"));
  const cover = decodeURIComponent(win.url.split(",").slice(1).join(","));
  assert.match(cover, /Codecast is signed out/);
  assert.match(cover, /Sign in to Codecast to use Vitals\./);
  // The cover's control opens Codecast; the bridge stays shut on the cover.
  win.webContents.openHandler({ url: OPEN_CODECAST });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(opened, [SLUG]);
  const reply = await r.handlers.get("cast-app:call")({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { id: 1, module: "app", method: "info", args: [] });
  assert.equal(reply.ok, false);
  signedIn = true;
  r.host.setSignedIn(true);
  assert.equal(win.url, `${ORIGIN}/${SLUG}?host=app&surface=window`);
  r.host.setSignedIn(true); // a repeat loads nothing
  assert.equal(win.calls.filter((c) => c[0] === "loadURL").length, 2);
  // On the page, the same link goes nowhere: codecast:// is not a scheme the OS gets.
  win.webContents.openHandler({ url: OPEN_CODECAST });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(opened, [SLUG]);
  assert.deepEqual(r.external, []);
  signedIn = false;
  r.host.setSignedIn(false);
  assert.equal(win.url, signedOutCoverUrl("Vitals"));
});

function fakeSpawn() {
  const children = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.args = args;
    child.kill = () => (child.killed = true);
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test("Windows toasts: one process at a time per app, three waiting at most, ten a minute", async () => {
  const fake = fakeSpawn();
  let clock = 1_000_000;
  const logs = [];
  const r = rig({ platform: "win32", extra: { spawn: fake.spawn, now: () => clock, log: (m) => logs.push(m) } });
  const ctx = { slug: SLUG };
  for (let i = 1; i <= 5; i++) r.host["app.notify"](ctx, { title: `t${i}` });
  assert.equal(fake.children.length, 1, "one toast process at a time");
  assert.equal(logs.length, 1, "the oldest waiting toast was dropped with a log");
  assert.match(logs[0], /t2/);
  fake.children[0].emit("close", 0);
  assert.equal(fake.children.length, 2);
  const script = (child) => Buffer.from(child.args.at(-1), "base64").toString("utf16le");
  assert.match(script(fake.children[1]), /t3/);
  fake.children[1].emit("error", new Error("gone"));
  fake.children[1].emit("close", 1); // error then close counts once
  assert.equal(fake.children.length, 3);
  assert.match(script(fake.children[2]), /t4/);
  for (let i = 6; i <= 10; i++) r.host["app.notify"](ctx, { title: `t${i}` });
  assert.throws(() => r.host["app.notify"](ctx, { title: "t11" }), (e) => e.code === "failed" && e.message === "too many notifications");
  clock += 61_000;
  r.host["app.notify"](ctx, { title: "later" });
});

test("a hung toast process is killed so the next toast can run", async () => {
  const fake = fakeSpawn();
  let done = 0;
  windowsToast({ appId: "a", title: "t" }, fake.spawn, () => done++, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.children[0].killed, true);
  assert.equal(done, 1);
  fake.children[0].emit("close", null); // the late close counts once
  assert.equal(done, 1);
});

test("a badge is put back on a window the app opens again (Windows)", async () => {
  const r = rig({ platform: "win32" });
  await r.host.open(SLUG);
  r.host["app.badge"]({ slug: SLUG }, 4);
  r.windows[0].close();
  await r.host.open(SLUG);
  const again = r.windows.at(-1);
  assert.notEqual(again, r.windows[0]);
  assert.equal(again.calls.find((c) => c[0] === "setOverlayIcon"), undefined, "no taskbar button to badge before the window shows");
  again.emit("show");
  assert.deepEqual(again.calls.find((c) => c[0] === "setOverlayIcon"), ["setOverlayIcon", { badge: true }, "4"]);
});

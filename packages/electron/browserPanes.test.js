// Run: node --test packages/electron/browserPanes.test.js
//
// The native browser pane, without an Electron process. Everything the manager
// touches is injected (createBrowserPanes), so these tests drive the real
// module against recorders and read what it asked Chromium to do.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  createBrowserPanes,
  paneViewBounds,
  isEmptyBounds,
  PANE_PARTITION,
} = require("./browserPanes");

// ── The stand-in shell ──────────────────────────────────────────────────────

class FakeWebContents extends EventEmitter {
  static nextId = 1;
  constructor(url = "https://codecast.sh/browser") {
    super();
    this.setMaxListeners(0);
    this.id = FakeWebContents.nextId++;
    this.url = url;
    this.sent = [];
    this.calls = [];
    this.destroyed = false;
    this.devtools = false;
    this.focused = false;
    this.zoom = 1;
    this.navigationHistory = {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => this.calls.push(["goBack"]),
      goForward: () => this.calls.push(["goForward"]),
    };
  }
  getURL() { return this.url; }
  getZoomFactor() { return this.zoom; }
  isDestroyed() { return this.destroyed; }
  isFocused() { return this.focused; }
  focus() { this.calls.push(["focus"]); this.focused = true; }
  send(channel, payload) { this.sent.push([channel, payload]); }
  loadURL(url) { this.url = url; this.calls.push(["loadURL", url]); }
  reload() { this.calls.push(["reload"]); }
  close() { this.destroyed = true; this.calls.push(["close"]); }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  isDevToolsOpened() { return this.devtools; }
  // Asynchronous, like Electron's: the devtools window exists a moment after
  // the call, so isDevToolsOpened() still reads false on the same tick.
  openDevTools(opts) { this.calls.push(["openDevTools", opts]); queueMicrotask(() => { this.devtools = true; }); }
  closeDevTools() { this.calls.push(["closeDevTools"]); queueMicrotask(() => { this.devtools = false; }); }
  /** The events this pane's renderer received, as {event, ...} payloads. */
  events(name) {
    return this.sent
      .filter(([ch]) => ch === "app:browser-pane")
      .map(([, p]) => p)
      .filter((p) => !name || p.event === name);
  }
}

class FakeView {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents("about:blank");
    this.bounds = null;
    this.visible = true;
    this.visibility = [];
  }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; this.visibility.push(v); }
}

class FakeWindow extends EventEmitter {
  constructor(webContents) {
    super();
    this.setMaxListeners(0);
    this.webContents = webContents;
    this.content = { width: 1200, height: 800 };
    this.minimized = false;
    this.shown = true;
    this.destroyed = false;
    this.children = [];
    this.contentView = {
      addChildView: (v) => this.children.push(v),
      removeChildView: (v) => { this.children = this.children.filter((c) => c !== v); },
    };
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.shown; }
  isMinimized() { return this.minimized; }
  getContentBounds() { return { x: 0, y: 0, ...this.content }; }
}

function rig({ trusted = true } = {}) {
  const host = new FakeWebContents();
  const win = new FakeWindow(host);
  const views = [];
  const handlers = new Map();
  const permissions = [];
  const panes = createBrowserPanes({
    WebContentsView: class extends FakeView {
      constructor(o) { super(o); views.push(this); }
    },
    session: {
      fromPartition: (name) => ({
        name,
        setPermissionRequestHandler: (fn) => permissions.push(["request", fn]),
        setPermissionCheckHandler: (fn) => permissions.push(["check", fn]),
      }),
    },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    BrowserWindow: { fromWebContents: (wc) => (wc === host ? win : null) },
    isTrusted: () => trusted,
  });
  panes.install();
  const send = (cmd, payload) => handlers.get("app:browser-pane")({ sender: host }, cmd, payload);
  /** Open one pane the way the renderer opens it, already measured. */
  const open = (paneId = "p1", url = "https://example.com") => {
    send("create", { paneId, url });
    send("bounds", { paneId, rect: { x: 100, y: 40, width: 600, height: 500 }, visible: true });
    return views[views.length - 1];
  };
  return { panes, host, win, views, handlers, permissions, send, open };
}

// ── Bounds ──────────────────────────────────────────────────────────────────

test("a measured rect becomes view bounds in the window's own pixels", () => {
  const rect = { x: 100, y: 40, width: 600, height: 500 };
  assert.deepEqual(paneViewBounds(rect, { zoomFactor: 1, contentWidth: 1200, contentHeight: 800 }), {
    x: 100, y: 40, width: 600, height: 500,
  });
  // A zoomed window: CSS pixels are bigger than the view's pixels, and the
  // bottom edge lands past the content area, so it is clipped there (810→800).
  assert.deepEqual(paneViewBounds(rect, { zoomFactor: 1.5, contentWidth: 1200, contentHeight: 800 }), {
    x: 150, y: 60, width: 900, height: 740,
  });
});

test("both edges round, so the view never drifts off the strip above it", () => {
  // x=10.4 and width=100.4 → right edge 110.8. Rounding the size on its own
  // would give x=10 width=100 (right edge 110) and leave a seam at 111.
  const b = paneViewBounds({ x: 10.4, y: 0, width: 100.4, height: 10 }, {
    zoomFactor: 1, contentWidth: 1000, contentHeight: 1000,
  });
  assert.deepEqual(b, { x: 10, y: 0, width: 101, height: 10 });
});

test("a pane hanging off the window is clipped, not painted over the edge", () => {
  const b = paneViewBounds({ x: 900, y: 700, width: 600, height: 400 }, {
    zoomFactor: 1, contentWidth: 1200, contentHeight: 800,
  });
  assert.deepEqual(b, { x: 900, y: 700, width: 300, height: 100 });
  // Entirely outside: nothing to show.
  const gone = paneViewBounds({ x: 1400, y: 0, width: 200, height: 200 }, {
    zoomFactor: 1, contentWidth: 1200, contentHeight: 800,
  });
  assert.ok(isEmptyBounds(gone));
});

test("a nonsense zoom factor falls back to 1 rather than collapsing the view", () => {
  const b = paneViewBounds({ x: 0, y: 0, width: 100, height: 100 }, {
    zoomFactor: 0, contentWidth: 500, contentHeight: 500,
  });
  assert.deepEqual(b, { x: 0, y: 0, width: 100, height: 100 });
});

// ── The manager ─────────────────────────────────────────────────────────────

test("a pane is born hidden and appears only once it has been measured", () => {
  const r = rig();
  r.send("create", { paneId: "p1", url: "https://example.com" });
  const view = r.views[0];
  assert.equal(view.visible, false, "no flash of a full-window page before the first rect");
  r.send("bounds", { paneId: "p1", rect: { x: 10, y: 32, width: 400, height: 300 }, visible: true });
  assert.equal(view.visible, true);
  assert.deepEqual(view.bounds, { x: 10, y: 32, width: 400, height: 300 });
  assert.equal(view.webContents.url, "https://example.com");
});

test("panes load in their own persistent partition, and that session grants nothing", () => {
  const r = rig();
  const view = r.open();
  assert.equal(view.options.webPreferences.session.name, PANE_PARTITION);
  assert.equal(view.options.webPreferences.preload, undefined, "a stranger never gets our bridge");
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.sandbox, true);
  const answers = [];
  for (const [, fn] of r.permissions) fn({}, "media", (ok) => answers.push(ok));
  assert.deepEqual(answers.filter((a) => a !== undefined), [false], "requests are denied");
  assert.equal(r.permissions.find(([kind]) => kind === "check")[1](), false);
});

test("only a first-party page may open a view", () => {
  const r = rig({ trusted: false });
  assert.deepEqual(r.send("create", { paneId: "p1", url: "https://evil.test" }), {
    ok: false, reason: "untrusted",
  });
  assert.equal(r.views.length, 0);
});

test("hiding a focused view hands the keyboard back to the app", () => {
  const r = rig();
  const view = r.open();
  view.webContents.focused = true;
  r.send("hide", { paneId: "p1" });
  assert.equal(view.visible, false);
  assert.ok(r.host.calls.some(([c]) => c === "focus"), "the palette can see its own keys again");
});

test("a minimized window hides every pane in it, and restoring brings them back", () => {
  const r = rig();
  const view = r.open();
  assert.equal(view.visible, true);
  r.win.minimized = true;
  r.win.emit("minimize");
  assert.equal(view.visible, false);
  r.win.minimized = false;
  r.win.emit("restore");
  assert.equal(view.visible, true);
});

test("a window resize re-clips the panes it holds", () => {
  const r = rig();
  const view = r.open();
  r.win.content = { width: 400, height: 300 };
  r.win.emit("resize");
  assert.deepEqual(view.bounds, { x: 100, y: 40, width: 300, height: 260 });
});

test("the renderer going away takes its views with it", () => {
  const r = rig();
  const view = r.open();
  assert.equal(r.panes.panes.size, 1);
  r.host.emit("did-navigate", {}, "https://codecast.sh/inbox");
  assert.equal(r.panes.panes.size, 0, "views must not outlive the page that placed them");
  assert.equal(r.win.children.length, 0);
  assert.ok(view.webContents.isDestroyed());
});

test("a host that is destroyed still takes its views with it", () => {
  const r = rig();
  const view = r.open();
  // Electron's destroyed web contents throw on every property read, and the
  // destroyed event is exactly when the shell hears about it. The pane must
  // close anyway, or its renderer lives on invisible (measured in the rig:
  // a github.com view survived its window).
  const host = r.host;
  host.destroyed = true;
  Object.defineProperty(host, "id", {
    get() {
      throw new Error("Object has been destroyed");
    },
  });
  host.emit("destroyed");
  assert.equal(r.panes.panes.size, 0, "the pane record is gone");
  assert.ok(view.webContents.isDestroyed(), "and so is its renderer");
});

test("a window closing destroys its panes", () => {
  const r = rig();
  r.open();
  r.win.emit("closed");
  assert.equal(r.panes.panes.size, 0);
});

test("a link that wants a new window opens in the same pane", () => {
  const r = rig();
  const view = r.open();
  const answer = view.webContents.windowOpenHandler({ url: "https://example.com/deep" });
  assert.deepEqual(answer, { action: "deny" }, "never leak the page to the system browser");
  assert.equal(view.webContents.url, "https://example.com/deep");
  assert.equal(r.host.events("url").at(-1).url, "https://example.com/deep");
});

test("a new window asking for a non-web scheme is refused outright", () => {
  const r = rig();
  const view = r.open();
  view.webContents.windowOpenHandler({ url: "file:///etc/passwd" });
  assert.equal(view.webContents.url, "https://example.com");
});

test("the page's own keys stay in the page; the app's chords come back to it", () => {
  const r = rig();
  const view = r.open();
  const press = (key, mods = {}) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    view.webContents.emit("before-input-event", event, {
      type: "keyDown", key, meta: process.platform === "darwin", control: process.platform !== "darwin", ...mods,
    });
    return event.defaultPrevented;
  };
  assert.equal(press("c"), false, "copy belongs to the page");
  assert.equal(press("k"), true);
  assert.equal(press("l"), true);
  assert.equal(press("r"), true);
  assert.deepEqual(r.host.events("chord").map((e) => e.key), ["k", "l", "r"]);
  // A bare key is the page's, whatever it is.
  assert.equal(press("l", { meta: false, control: false }), false);
});

test("page facts reach the renderer as pane events", () => {
  const r = rig();
  const view = r.open();
  view.webContents.emit("page-title-updated", {}, "Example Domain");
  view.webContents.emit("did-start-loading");
  view.webContents.emit("did-stop-loading");
  view.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://nope.test", true);
  view.webContents.emit("focus");
  assert.equal(r.host.events("title").at(-1).title, "Example Domain");
  assert.deepEqual(r.host.events("loading").map((e) => e.loading), [true, false]);
  assert.equal(r.host.events("fail").at(-1).errorCode, -105);
  assert.equal(r.host.events("focus").length, 1);
});

test("an aborted navigation is not an error the pane paints", () => {
  const r = rig();
  const view = r.open();
  view.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.com", true);
  // A subframe failing is not the pane failing either.
  view.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://ad.test", false);
  assert.equal(r.host.events("fail").length, 0);
});

test("devtools toggle per pane, detached so they never eat the split", async () => {
  const r = rig();
  const view = r.open();
  // The answer names the state asked for, even though the window opens a
  // moment later: the strip must not read "closed" while devtools appear.
  assert.deepEqual(r.send("devtools", { paneId: "p1" }), { ok: true, open: true });
  assert.deepEqual(view.webContents.calls.at(-1), ["openDevTools", { mode: "detach" }]);
  await Promise.resolve();
  assert.deepEqual(r.send("devtools", { paneId: "p1" }), { ok: true, open: false });
  assert.deepEqual(view.webContents.calls.at(-1), ["closeDevTools"]);
});

test("history verbs move the view, and only when there is somewhere to go", () => {
  const r = rig();
  const view = r.open();
  r.send("back", { paneId: "p1" });
  r.send("forward", { paneId: "p1" });
  assert.deepEqual(view.webContents.calls.filter(([c]) => c.startsWith("go")), [["goBack"]]);
});

test("commands for a pane that is gone are a no-op, not a crash", () => {
  const r = rig();
  r.open();
  r.send("destroy", { paneId: "p1" });
  assert.deepEqual(r.send("reload", { paneId: "p1" }), { ok: false });
  assert.deepEqual(r.send("nonsense", { paneId: "p1" }), { ok: false, reason: "unknown-command" });
});

test("creating the same pane twice reuses the view and follows the new address", () => {
  const r = rig();
  r.open("p1", "https://example.com");
  const answer = r.send("create", { paneId: "p1", url: "https://example.org" });
  assert.deepEqual(answer, { ok: true, reused: true });
  assert.equal(r.views.length, 1, "a remount must not stack two views on one pane");
  assert.equal(r.views[0].webContents.url, "https://example.org");
});

test("the shell can be asked what its views are doing, which nothing else can see", () => {
  const r = rig();
  r.open("p1", "https://example.com");
  const before = r.send("state", {});
  assert.equal(before.panes.length, 1);
  assert.equal(before.panes[0].visible, true);
  // A palette is up: the renderer hides the view, and this is the only place
  // that fact is observable — no screenshot of the page would show it.
  r.send("bounds", { paneId: "p1", rect: { x: 100, y: 40, width: 600, height: 500 }, visible: false });
  assert.equal(r.send("state", {}).panes[0].visible, false);
});

test("the capabilities probe answers only a trusted caller, and names its commands", () => {
  const r = rig();
  const caps = r.handlers.get("app:browser-pane-capabilities")({ sender: r.host });
  assert.equal(caps.available, true);
  assert.equal(caps.partition, PANE_PARTITION);
  for (const cmd of ["create", "navigate", "bounds", "destroy", "devtools"]) {
    assert.ok(caps.commands.includes(cmd), `${cmd} is part of the contract`);
  }
});

// ── The pane registry (what `cast browser` reads) ───────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { registryDocument, writeRegistryFile, REGISTRY_VERSION } = require("./browserPanes");

/** A rig whose shell advertises a CDP port and whose views answer the
 *  debugger's target question, the way Electron's do. */
function registryRig({ cdpPort = 9444, targetIds = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-registry-"));
  const file = path.join(dir, "browser", "desktop-panes.json");
  const host = new FakeWebContents();
  const win = new FakeWindow(host);
  const handlers = new Map();
  let minted = 0;
  const panes = createBrowserPanes({
    WebContentsView: class extends FakeView {
      constructor(o) {
        super(o);
        if (targetIds) {
          const id = `TARGET${++minted}`;
          this.webContents.debugger = {
            attached: false,
            isAttached() { return this.attached; },
            attach() { this.attached = true; },
            detach() { this.attached = false; },
            sendCommand: async (m) => (m === "Target.getTargetInfo" ? { targetInfo: { targetId: id } } : {}),
          };
        }
      }
    },
    session: { fromPartition: (name) => ({ name, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    BrowserWindow: { fromWebContents: (wc) => (wc === host ? win : null) },
    isTrusted: () => true,
    cdpPort,
    registryPath: file,
  });
  panes.install();
  const send = (cmd, payload) => handlers.get("app:browser-pane")({ sender: host }, cmd, payload);
  const read = () => JSON.parse(fs.readFileSync(file, "utf-8"));
  const mode = () => fs.statSync(file).mode & 0o777;
  // Registry writes coalesce onto a microtask; the debugger answers a tick later.
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { panes, host, handlers, file, dir, send, read, mode, settle, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("registry: the document names the port, this pid and each pane's target, url and session", () => {
  const panes = [
    { paneId: "p1", hostId: 7, targetId: "T1", url: "https://example.com/", session: "509b4b48-c521-4352-bf19-eafa153745bb", view: { webContents: { isDestroyed: () => false } } },
    { paneId: "p2", hostId: 7, targetId: null, url: null, session: null, view: { webContents: { isDestroyed: () => true } } },
  ];
  const doc = registryDocument(panes, { port: "9444", pid: 42, now: 1000 });
  assert.deepEqual(doc, {
    version: REGISTRY_VERSION,
    port: 9444,
    pid: 42,
    updatedAt: 1000,
    // The destroyed one is gone from the document: nothing can attach to it.
    panes: [{ paneId: "p1", hostId: 7, targetId: "T1", url: "https://example.com/", session: "509b4b48-c521-4352-bf19-eafa153745bb" }],
  });
});

test("registry: written 0600 in a 0700 directory, atomically, and removed when there is nothing to advertise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-registry-"));
  const file = path.join(dir, "browser", "desktop-panes.json");
  try {
    assert.equal(writeRegistryFile(file, { version: 1, port: 9444, panes: [] }), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.readdirSync(path.dirname(file)).length, 1, "no temp file left beside it");
    assert.equal(writeRegistryFile(file, null), true);
    assert.equal(fs.existsSync(file), false);
    // A second removal is fine, and so is an unwritable path.
    assert.equal(writeRegistryFile(file, null), true);
    assert.equal(writeRegistryFile("/dev/null/nope/desktop-panes.json", { version: 1 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: install writes an empty document, then create, navigate and destroy each rewrite it", async () => {
  const r = registryRig();
  try {
    assert.deepEqual(r.read().panes, []);
    assert.equal(r.read().port, 9444);
    assert.equal(r.read().pid, process.pid);
    assert.equal(r.mode(), 0o600);

    r.send("create", { paneId: "p1", url: "https://example.com", session: "509b4b48-c521-4352-bf19-eafa153745bb" });
    await r.settle();
    let [pane] = r.read().panes;
    assert.equal(pane.paneId, "p1");
    assert.equal(pane.url, "https://example.com");
    assert.equal(pane.session, "509b4b48-c521-4352-bf19-eafa153745bb");
    assert.equal(pane.targetId, "TARGET1", "the debugger's answer is the CDP target id");
    const view = r.panes.panes.get(`${r.host.id}:p1`).view;
    assert.equal(view.webContents.debugger.attached, false, "the debugger is let go once the id is known");

    r.send("navigate", { paneId: "p1", url: "https://example.org/x" });
    await r.settle();
    assert.equal(r.read().panes[0].url, "https://example.org/x");

    // The page moved on its own (a redirect, a clicked link): the file follows.
    view.webContents.emit("did-navigate", {}, "https://example.org/y");
    await r.settle();
    assert.equal(r.read().panes[0].url, "https://example.org/y");
    view.webContents.emit("did-navigate-in-page", {}, "https://example.org/y#z", true);
    await r.settle();
    assert.equal(r.read().panes[0].url, "https://example.org/y#z");

    r.send("destroy", { paneId: "p1" });
    await r.settle();
    assert.deepEqual(r.read().panes, []);
  } finally {
    r.cleanup();
  }
});

test("registry: a pane nobody offered has no session, and a malformed session key is dropped", async () => {
  const r = registryRig();
  try {
    r.send("create", { paneId: "p1", url: "https://example.com" });
    r.send("create", { paneId: "p2", url: "https://example.com", session: "not a key; rm -rf" });
    await r.settle();
    const [a, b] = r.read().panes;
    assert.equal(a.session, null);
    assert.equal(b.session, null);
    // A remount that now names the session (the offer chip re-opened it)
    // records the owner without a new view.
    r.send("create", { paneId: "p1", url: "https://example.com", session: "env-abc_1" });
    await r.settle();
    assert.equal(r.read().panes.find((p) => p.paneId === "p1").session, "env-abc_1");
  } finally {
    r.cleanup();
  }
});

test("registry: no CDP port means no file, and a stale one from an earlier run is removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-registry-"));
  const file = path.join(dir, "browser", "desktop-panes.json");
  try {
    writeRegistryFile(file, { version: 1, port: 9333, pid: 1, panes: [{ paneId: "old" }] });
    const r = registryRig({ cdpPort: "" });
    r.cleanup();
    const again = createBrowserPanes({
      WebContentsView: FakeView,
      session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
      ipcMain: { handle() {} },
      BrowserWindow: { fromWebContents: () => null },
      isTrusted: () => true,
      cdpPort: "",
      registryPath: file,
    });
    again.install();
    assert.equal(fs.existsSync(file), false);
    // And the capabilities probe says so, so the web can tell an agent-drivable pane from one that is not.
    const handlers = new Map();
    createBrowserPanes({
      WebContentsView: FakeView,
      session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      BrowserWindow: { fromWebContents: () => null },
      isTrusted: () => true,
    }).install();
    assert.equal(handlers.get("app:browser-pane-capabilities")({ sender: {} }).drivable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registry: a view whose debugger will not attach is still listed, without a target id", async () => {
  const r = registryRig({ targetIds: false });
  try {
    r.send("create", { paneId: "p1", url: "https://example.com", session: "s1" });
    await r.settle();
    assert.equal(r.read().panes[0].targetId, null);
    assert.equal(r.read().panes[0].url, "https://example.com");
  } finally {
    r.cleanup();
  }
});

test("registry: a manager built without a path never writes anywhere", () => {
  const r = rig();
  r.open();
  assert.equal(r.panes.registryPath, null);
  assert.equal(r.panes.writeRegistry(), false);
});

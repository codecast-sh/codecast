// Run: node --test packages/electron/installedApps/consentWindow.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createConsentWindows, centeredOn, fitConsent, CONSENT_MIN_HEIGHT } = require("./consentWindow");

class FakeWin extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.destroyed = false;
    this.calls = [];
    // A 28px title bar above the content, as on macOS.
    this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height + 28 };
  }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { x: this.bounds.x, y: this.bounds.y + 28, width: this.bounds.width, height: this.bounds.height - 28 }; }
  setContentSize(width, height) { this.calls.push(["setContentSize", width, height]); this.bounds = { ...this.bounds, width, height: height + 28 }; }
  setPosition(x, y) { this.calls.push(["setPosition", x, y]); this.bounds = { ...this.bounds, x, y }; }
  isDestroyed() { return this.destroyed; }
  setAlwaysOnTop(...a) { this.calls.push(["setAlwaysOnTop", ...a]); }
  loadURL(url) { this.url = url; }
  show() { this.calls.push(["show"]); }
  focus() { this.calls.push(["focus"]); }
  close() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
}

function rig() {
  const wins = [];
  let n = 0;
  const consent = createConsentWindows({
    createWindow: (opts) => { const w = new FakeWin(opts); wins.push(w); return w; },
    url: (id) => `https://codecast.sh/apps/consent/${id}`,
    display: () => ({ x: 0, y: 0, width: 1600, height: 1000 }),
    newId: () => `c${++n}`,
  });
  return { consent, wins };
}
const INFO = { slug: "k3j2h4ab", version: 7, app: { name: "Vitals" } };

test("the route reads its request and an approval resolves with the grants", async () => {
  const { consent, wins } = rig();
  const p = consent.ask({ kind: "request", info: INFO, asked: ["notifications", "notifications"], current: [], added: ["notifications"] }, { x: 100, y: 100, width: 800, height: 600 });
  const win = wins[0];
  assert.equal(win.url, "https://codecast.sh/apps/consent/c1");
  assert.equal(win.opts.x, 100 + (800 - 460) / 2);
  assert.equal(win.opts.alwaysOnTop, true);
  assert.equal(win.opts.useContentSize, true);
  assert.deepEqual(win.calls[0], ["setAlwaysOnTop", true, "screen-saver"]);
  win.emit("ready-to-show");
  assert.equal(consent.resize("c1", 300), true);
  assert.deepEqual(win.calls.slice(1), [["setContentSize", 460, 300], ["setPosition", 270, 100 + (600 - 328) / 2], ["show"], ["focus"]]);
  assert.deepEqual(consent.get("c1"), { id: "c1", kind: "request", info: INFO, asked: ["notifications"], current: [], added: ["notifications"] });
  assert.equal(consent.answer("c1", { approve: true, grants: ["notifications", 3] }), true);
  assert.deepEqual(await p, { grants: ["notifications"] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.destroyed, true, "the sheet closes once answered");
  assert.equal(consent.get("c1"), null);
  assert.equal(consent.answer("c1", { approve: true, grants: [] }), false, "an id answers once");
});

test("closing the sheet, or answering no, is a refusal", async () => {
  const { consent, wins } = rig();
  const closed = consent.ask({ kind: "install", info: INFO, asked: [], current: [], added: [] });
  wins[0].close();
  assert.equal(await closed, null);
  const declined = consent.ask({ kind: "request", info: INFO, asked: ["agent"], current: [], added: ["agent"] });
  consent.answer("c2", { approve: false, grants: ["agent"] });
  assert.equal(await declined, null);
  assert.equal(consent.size(), 0);
});

test("a second ask of the same kind for the same app shares the open sheet", async () => {
  const { consent, wins } = rig();
  const a = consent.ask({ kind: "request", info: INFO, asked: ["agent"], current: [], added: [] });
  const b = consent.ask({ kind: "request", info: INFO, asked: ["agent"], current: [], added: [] });
  assert.equal(wins.length, 1);
  consent.answer("c1", { approve: true, grants: ["agent"] });
  assert.deepEqual(await a, { grants: ["agent"] });
  assert.deepEqual(await b, { grants: ["agent"] });
});

test("cancelAll refuses an app's open sheets", async () => {
  const { consent } = rig();
  const p = consent.ask({ kind: "review", info: INFO, asked: [], current: [], added: [] });
  consent.cancelAll("k3j2h4ab");
  assert.equal(await p, null);
});

test("a sheet without an app window sits in the middle of the display, and never off it", () => {
  assert.deepEqual(centeredOn(null, { width: 460, height: 620 }, { x: 0, y: 0, width: 1600, height: 1000 }), { x: 570, y: 190 });
  assert.deepEqual(centeredOn({ x: 1500, y: 900, width: 200, height: 100 }, { width: 460, height: 620 }, { x: 0, y: 0, width: 1600, height: 1000 }), { x: 1140, y: 380 });
});

test("the sheet's height fits its content, clamped to the work area, centered over the app", () => {
  const area = { x: 0, y: 25, width: 1600, height: 875 };
  const anchor = { x: 200, y: 100, width: 800, height: 600 };
  // A short review: the window shrinks to it and centers on the app.
  assert.deepEqual(fitConsent({ height: 301.4, width: 460, chrome: 28, anchor, area }), { contentHeight: 302, x: 370, y: 100 + (600 - 330) / 2 });
  // Taller than the screen: the content gets what the work area leaves under the title bar, top at the area's top.
  assert.deepEqual(fitConsent({ height: 2400, width: 460, chrome: 28, anchor, area }), { contentHeight: 847, x: 370, y: 25 });
  // Never shorter than a header, one row and the footer.
  assert.equal(fitConsent({ height: 40, width: 460, chrome: 28, anchor, area }).contentHeight, CONSENT_MIN_HEIGHT);
  // A work area shorter than the minimum still wins.
  assert.equal(fitConsent({ height: 500, width: 460, chrome: 28, anchor: null, area: { x: 0, y: 0, width: 800, height: 200 } }).contentHeight, 172);
});

test("a resize for an unknown id or a nonsense height does nothing, and a route that never reports still shows", async () => {
  const { consent, wins } = rig();
  consent.ask({ kind: "install", info: INFO, asked: [], current: [], added: [] });
  const win = wins[0];
  assert.equal(consent.resize("nope", 300), false);
  assert.equal(consent.resize("c1", NaN), false);
  assert.equal(consent.resize("c1", 0), false);
  win.emit("ready-to-show");
  assert.deepEqual(win.calls.slice(1), [], "waits for the route's height");
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(win.calls.slice(1), [["show"], ["focus"]]);
  consent.resize("c1", 400);
  assert.deepEqual(win.calls.slice(-2).map((c) => c[0]), ["setContentSize", "setPosition"], "later reports resize without showing again");
  win.close();
});

test("a height before ready-to-show reveals once and arms no fallback; neither does an answered sheet", (t) => {
  const fallbacks = () => setTimeout.mock.calls.filter((c) => c.arguments[1] === 400).length;
  t.mock.method(globalThis, "setTimeout");
  const { consent, wins } = rig();
  consent.ask({ kind: "install", info: INFO, asked: [], current: [], added: [] });
  const win = wins[0];
  assert.equal(consent.resize("c1", 300), true);
  win.emit("ready-to-show");
  consent.resize("c1", 320);
  assert.equal(fallbacks(), 0);
  assert.deepEqual(win.calls.filter((c) => c[0] === "show"), [["show"]], "shown once");

  consent.ask({ kind: "request", info: INFO, asked: [], current: [], added: [] });
  consent.answer("c2", { approve: false });
  wins[1].emit("ready-to-show");
  assert.equal(fallbacks(), 0);
  assert.deepEqual(wins[1].calls.filter((c) => c[0] === "show"), []);
  win.close();
});

test("the sheet sits above every window level an installed app can reach, so an overlay cannot cover it", () => {
  const { CONSENT_LEVEL } = require("./consentWindow");
  // Electron's setAlwaysOnTop levels, lowest first (BrowserWindow docs).
  const LEVELS = ["normal", "floating", "torn-off-menu", "modal-panel", "main-menu", "status", "pop-up-menu", "screen-saver"];
  const above = (level) => LEVELS.indexOf(CONSENT_LEVEL) > LEVELS.indexOf(level);
  // electronHost's window.setAlwaysOnTop and the shim's overlay (.floating);
  // the shim's tray panel (TrayPanel.swift, .popUpMenu).
  const fs = require("node:fs");
  const path = require("node:path");
  const electronHost = fs.readFileSync(path.join(__dirname, "electronHost.js"), "utf8");
  for (const [, level] of electronHost.matchAll(/setAlwaysOnTop\([^)]*?"([a-z-]+)"\)/g)) assert.ok(above(level), level);
  const shim = fs.readFileSync(path.join(__dirname, "..", "appshim", "Sources", "main.swift"), "utf8");
  assert.match(shim, /window\.level = on \? \.floating : \.normal/);
  assert.ok(above("floating"));
  const tray = fs.readFileSync(path.join(__dirname, "..", "appshim", "Sources", "TrayPanel.swift"), "utf8");
  assert.match(tray, /level = \.popUpMenu/);
  assert.ok(above("pop-up-menu"));
});

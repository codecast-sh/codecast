// Run: node --test packages/electron/installedApps/consentWindow.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createConsentWindows, centeredOn } = require("./consentWindow");

class FakeWin extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.destroyed = false; this.calls = []; }
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
  assert.deepEqual(win.calls[0], ["setAlwaysOnTop", true, "floating"]);
  win.emit("ready-to-show");
  assert.deepEqual(win.calls.slice(1), [["show"], ["focus"]]);
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeCursors, sourceRect, createShareCursors } = require("./shareCursors");

const DISPLAYS = [
  { id: 4, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 7, bounds: { x: 1512, y: -200, width: 2560, height: 1440 } },
];
const screen = { getAllDisplays: () => DISPLAYS };

function fakeWindowAddon(frames) {
  return { windowFrame: (id) => frames.get(id) ?? null };
}

function rig({ frames = new Map() } = {}) {
  const glasses = [];
  const intervals = [];
  const timers = {
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (h) => { intervals[h - 1] = null; },
  };
  const createGlass = () => {
    const g = {
      visible: false, destroyed: false, bounds: null, sent: [],
      isDestroyed: () => g.destroyed,
      isVisible: () => g.visible,
      showInactive: () => { g.visible = true; },
      hide: () => { g.visible = false; },
      setBounds: (b) => { g.bounds = b; },
      webContents: { send: (ch, payload) => g.sent.push([ch, payload]) },
    };
    glasses.push(g);
    return g;
  };
  const sc = createShareCursors({ createGlass, screen, addon: fakeWindowAddon(frames), timers });
  const wc = () => {
    const handlers = {};
    return { once: (ev, fn) => { handlers[ev] = fn; }, destroy: () => handlers.destroyed?.() };
  };
  const tick = () => intervals.forEach((fn) => fn && fn());
  return { sc, glasses, wc, tick, intervals };
}

const cursor = (id, nx, ny) => ({ id, name: `Person ${id}`, nx, ny });

test("a screen share maps to its display's bounds, by display id or by the id in the source", () => {
  assert.deepEqual(sourceRect({ id: "screen:7:0", displayId: "7" }, { screen }), DISPLAYS[1].bounds);
  assert.deepEqual(sourceRect({ id: "screen:4:0", displayId: null }, { screen }), DISPLAYS[0].bounds);
  assert.equal(sourceRect({ id: "screen:9:0", displayId: "9" }, { screen }), null);
});

test("a window share maps to the window's frame, and to nothing when it is off screen or gone", () => {
  const addon = fakeWindowAddon(new Map([
    [311, { x: 100.4, y: 50, width: 800, height: 600, onscreen: true }],
    [312, { x: 0, y: 0, width: 800, height: 600, onscreen: false }],
  ]));
  assert.deepEqual(sourceRect({ id: "window:311:0" }, { screen, addon }), { x: 100, y: 50, width: 800, height: 600 });
  assert.equal(sourceRect({ id: "window:312:0" }, { screen, addon }), null);
  assert.equal(sourceRect({ id: "window:313:0" }, { screen, addon }), null);
  assert.equal(sourceRect({ id: "window:311:0" }, { screen, addon: null }), null);
});

test("cursors from a renderer are clamped and malformed ones dropped", () => {
  assert.deepEqual(
    sanitizeCursors([cursor("a", 1.4, -0.2), { id: "", nx: 0, ny: 0 }, { id: "b", nx: NaN, ny: 0 }, null]),
    [{ id: "a", name: "Person a", nx: 1, ny: 0 }],
  );
  assert.deepEqual(sanitizeCursors("nope"), []);
});

test("the glass covers the shared display, draws the cursors, and hides when they leave", () => {
  const { sc, glasses, wc } = rig();
  const call = wc();
  sc.setSource(call, { id: "screen:7:0", displayId: "7" });
  sc.update(call, [cursor("cam", 0.5, 0.25)]);
  assert.equal(glasses.length, 1);
  const g = glasses[0];
  assert.deepEqual(g.bounds, DISPLAYS[1].bounds);
  assert.equal(g.visible, true);
  assert.deepEqual(g.sent.at(-1), ["app:share-cursors", [{ id: "cam", name: "Person cam", nx: 0.5, ny: 0.25 }]]);

  sc.update(call, []);
  assert.equal(g.visible, false);
  // The next cursor reuses the same glass.
  sc.update(call, [cursor("cam", 0.1, 0.1)]);
  assert.equal(glasses.length, 1);
  assert.equal(g.visible, true);
});

test("a renderer that is not sharing draws nothing", () => {
  const { sc, glasses, wc } = rig();
  sc.update(wc(), [cursor("cam", 0.5, 0.5)]);
  assert.equal(glasses.length, 0);
});

test("a shared window is followed as it moves, and the arrows hide while it is off screen", () => {
  const frames = new Map([[42, { x: 10, y: 20, width: 300, height: 200, onscreen: true }]]);
  const { sc, glasses, wc, tick } = rig({ frames });
  const call = wc();
  sc.setSource(call, { id: "window:42:0", displayId: null });
  sc.update(call, [cursor("cam", 0.5, 0.5)]);
  const g = glasses[0];
  assert.deepEqual(g.bounds, { x: 10, y: 20, width: 300, height: 200 });

  frames.set(42, { x: 400, y: 20, width: 300, height: 200, onscreen: true });
  tick();
  assert.deepEqual(g.bounds, { x: 400, y: 20, width: 300, height: 200 });

  frames.set(42, { x: 400, y: 20, width: 300, height: 200, onscreen: false });
  tick();
  assert.equal(g.visible, false);

  frames.set(42, { x: 400, y: 20, width: 300, height: 200, onscreen: true });
  tick();
  assert.equal(g.visible, true);
});

test("the sharing renderer going away takes its cursors with it", () => {
  const { sc, glasses, wc } = rig();
  const call = wc();
  sc.setSource(call, { id: "screen:4:0", displayId: "4" });
  sc.update(call, [cursor("cam", 0.5, 0.5)]);
  call.destroy();
  assert.equal(glasses[0].visible, false);
  sc.update(call, [cursor("cam", 0.5, 0.5)]);
  assert.equal(glasses[0].visible, false);
});

test("a new share moves the glass to the new source", () => {
  const { sc, glasses, wc } = rig();
  const call = wc();
  sc.setSource(call, { id: "screen:4:0", displayId: "4" });
  sc.update(call, [cursor("cam", 0.5, 0.5)]);
  sc.setSource(call, { id: "screen:7:0", displayId: "7" });
  assert.deepEqual(glasses[0].bounds, DISPLAYS[1].bounds);
});

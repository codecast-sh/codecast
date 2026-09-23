const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  callWindowTitle,
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  floatCornerFor,
  floatAnchorOf,
  floatPositionFor,
  normalizeCallWindowSize,
  isCallSize,
  CALL_SIZES,
  CALL_WINDOW_SIZES,
  LEGACY_FLOAT_SIZES,
} = require("./callWindowPolicy");

// A live call is at stake in every one of these, and the shell is the only
// side that can see the windows, so the rule is pinned here rather than
// inferred from whichever window happens to be closing.

const facts = (over) => ({
  ended: false,
  quitting: false,
  host: false,
  room: "dm:a:b",
  ...over,
});

test("a live huddle is never poured into the main window", () => {
  // The main window is not a fallback surface. An in-app card cannot leave
  // that window's edges, which is why the huddle has a window of its own.
  assert.equal(shouldHandBackCall(facts({})), false);
  assert.equal(shouldHideCallWindow(facts({})), true);
});

test("hiding keeps the huddle; for an older renderer, hang-up and quit actually close", () => {
  assert.equal(shouldHideCallWindow(facts({ ended: true })), false);
  assert.equal(shouldHideCallWindow(facts({ quitting: true })), false);
});

test("a voice host is never destroyed by its own hang-up, only by the app quitting", () => {
  // It holds the walkie's ear between calls. Destroying it on hang-up would
  // cost the next burst a renderer boot before anybody could hear it.
  assert.equal(shouldHideCallWindow(facts({ ended: true, host: true })), true);
  assert.equal(shouldHideCallWindow(facts({ host: true })), true);
  assert.equal(shouldHideCallWindow(facts({ quitting: true, host: true })), false);
  assert.equal(shouldHideCallWindow(facts({ ended: true, quitting: true, host: true })), false);
});

test("a hang-up hands nothing back", () => {
  assert.equal(shouldHandBackCall(facts({ ended: true })), false);
});

test("quitting hands nothing back, even with a call running", () => {
  // Every window gets `close` during a quit; a handback would raise the main
  // window on the way out and ask it to join a room this process is ending.
  assert.equal(shouldHandBackCall(facts({ quitting: true })), false);
});

test("a window that never hosted anything hands nothing back", () => {
  assert.equal(shouldHandBackCall(facts({ room: null })), false);
});

// ── The shapes ────────────────────────────────────────────────────────────

test("four shapes: the stage, the float, the wall and idle", () => {
  // The float is the one shape for every state of the row. A burst becoming
  // a call is the same shape drawing something else, so the window keeps
  // its media and its place.
  assert.deepEqual(CALL_SIZES, ["panel", "float"]);
  assert.deepEqual(CALL_WINDOW_SIZES, ["panel", "float", "wall", "idle"]);
  for (const size of CALL_SIZES) assert.equal(isCallSize(size), true, size);
  for (const size of ["wall", "idle", "nonsense"]) assert.equal(isCallSize(size), false, size);
});

test("the shapes the row replaced all land on the float", () => {
  // An older web build still names them. Each was a floating glance; the
  // float is that glance, so none of them may fall to the stage.
  assert.deepEqual(LEGACY_FLOAT_SIZES, ["ring", "walkie", "circles", "speaker", "tiny", "faces"]);
  for (const size of LEGACY_FLOAT_SIZES) assert.equal(normalizeCallWindowSize(size), "float", size);
});

test("an unknown size lands on the stage, never on a click-through window", () => {
  // The size arrives over IPC from a renderer, on a channel that changes what
  // the window IS. Anything unrecognized has to fail to the window a person
  // can see and click.
  for (const bad of ["banana", "", null, undefined, 3, {}]) {
    assert.equal(normalizeCallWindowSize(bad), "panel", String(bad));
  }
  for (const size of CALL_WINDOW_SIZES) assert.equal(normalizeCallWindowSize(size), size);
});

// ── What kind of window each shape is ─────────────────────────────────────

test("the stage is an ordinary window: no float, no click-through, resizable", () => {
  assert.deepEqual(callWindowChrome("panel"), {
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
    clickThrough: false,
    resizable: true,
  });
});

test("the float is above the work, on every desktop, and lets the mouse through", () => {
  assert.deepEqual(callWindowChrome("float"), {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    clickThrough: true,
    resizable: false,
  });
});

test("the float and the click-through move together", () => {
  // Apart they are each a bug: a window that floats over everything and still
  // takes every click is a pane sitting on somebody's work, and a
  // click-through window that is NOT on top is one you cannot reach at all.
  for (const size of [...CALL_SIZES, "nonsense"]) {
    const chrome = callWindowChrome(size);
    assert.equal(chrome.alwaysOnTop, chrome.clickThrough, size);
    assert.equal(chrome.resizable, !chrome.clickThrough, size);
  }
});

test("the wall is an ordinary window that floats only by its own pin", () => {
  // The buddy list: a card the person resizes and clicks in. Its pin is the
  // one it always had, above other apps and following the person between
  // desktops, and nothing about it is ever click-through.
  assert.deepEqual(callWindowChrome("wall"), {
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
    clickThrough: false,
    resizable: true,
  });
  assert.deepEqual(callWindowChrome("wall", { pinned: true }), {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    clickThrough: false,
    resizable: true,
  });
  // The pin means nothing to any other shape.
  assert.deepEqual(callWindowChrome("panel", { pinned: true }), callWindowChrome("panel"));
  assert.deepEqual(callWindowChrome("float", { pinned: true }), callWindowChrome("float"));
});

// ── Where each shape is remembered ────────────────────────────────────────

test("the stage's bounds, the float's anchor and the wall's rectangle are remembered separately", () => {
  // Saving one over another would drag each shape to where the other was
  // last left. A hidden window is nowhere.
  assert.equal(callWindowPlacementKey("panel"), "bounds");
  assert.equal(callWindowPlacementKey("float"), "float");
  assert.equal(callWindowPlacementKey("wall"), "wall");
  assert.equal(callWindowPlacementKey("idle"), null);
  // The old names share the float's one anchor: there is no strip corner and
  // no ring corner left to jump to.
  for (const size of LEGACY_FLOAT_SIZES) assert.equal(callWindowPlacementKey(size), "float", size);
});

// ── The anchor ────────────────────────────────────────────────────────────

const AREA = { x: 0, y: 0, width: 1600, height: 1000 };

test("the corner is the one the window sits nearest, ties to the top and the right", () => {
  assert.equal(floatCornerFor({ x: 1300, y: 30, width: 200, height: 80 }, AREA), "top-right");
  assert.equal(floatCornerFor({ x: 1300, y: 880, width: 200, height: 80 }, AREA), "bottom-right");
  assert.equal(floatCornerFor({ x: 40, y: 880, width: 200, height: 80 }, AREA), "bottom-left");
  assert.equal(floatCornerFor({ x: 40, y: 30, width: 200, height: 80 }, AREA), "top-left");
  // Dead centre: the default corner, so a first drag that lands in the
  // middle does not flip the row to growing rightwards.
  assert.equal(floatCornerFor({ x: 700, y: 460, width: 200, height: 80 }, AREA), "top-right");
  // A display that does not start at the origin is measured from its own edge.
  assert.equal(floatCornerFor({ x: 1700, y: 30, width: 200, height: 80 }, { x: 1600, y: 0, width: 1600, height: 1000 }), "top-left");
});

test("the anchor is the corner's screen point, and hanging a size from it lands the same corner back", () => {
  const bounds = { x: 1300, y: 30, width: 200, height: 80 };
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const anchor = floatAnchorOf(bounds, corner);
    assert.equal(anchor.corner, corner);
    // The same window, hung from its own anchor, sits where it was.
    assert.deepEqual(floatPositionFor(anchor, bounds), { x: 1300, y: 30 }, corner);
    // A bigger window hung from the same anchor keeps that corner put and
    // grows away from it.
    const bigger = floatPositionFor(anchor, { width: 300, height: 120 });
    const grown = { ...bigger, width: 300, height: 120 };
    assert.deepEqual(floatAnchorOf(grown, corner), anchor, corner);
  }
  assert.deepEqual(floatAnchorOf(bounds, "top-right"), { x: 1500, y: 30, corner: "top-right" });
  assert.deepEqual(floatAnchorOf(bounds, "bottom-left"), { x: 1300, y: 110, corner: "bottom-left" });
});

// ── The window's own construction options ─────────────────────────────────
//
// Read out of main.js rather than exercised, because constructing a
// BrowserWindow needs a running Electron app and this is the one property of
// the window that cannot be changed afterwards. `transparent` and `frame` are
// decided at construction: get them wrong and the fix is a new build, which is
// exactly why the float and the stage had to become one window.

const CREATE_CALL_WINDOW = (() => {
  const src = readFileSync(join(__dirname, "main.js"), "utf8");
  const start = src.indexOf("function ensureCallWindow(");
  assert.ok(start > 0, "ensureCallWindow not found in main.js");
  const end = src.indexOf("callWindow = win;", start);
  assert.ok(end > start, "ensureCallWindow's window assignment not found");
  return src.slice(start, end);
})();

test("the call window is born frameless and see-through", () => {
  for (const option of [
    "frame: false",
    "transparent: true",
    'backgroundColor: "#00000000"',
    "hasShadow: false",
  ]) {
    assert.ok(CREATE_CALL_WINDOW.includes(option), `ensureCallWindow is missing \`${option}\``);
  }
});

test("the call window has no title bar and no traffic lights", () => {
  // The stage draws its own card, drags by its own header row and closes by its
  // own button. A titleBarStyle here would put OS buttons on a transparent
  // window and cut a rectangle out of the float.
  assert.ok(!/titleBarStyle/.test(CREATE_CALL_WINDOW));
  assert.ok(!/trafficLightPosition/.test(CREATE_CALL_WINDOW));
  // An opaque backgroundColor would fill the glass in the float.
  assert.ok(!/backgroundColor: "#(?!00000000)/.test(CREATE_CALL_WINDOW));
});

test("the call window keeps the FaceDetector flag, because it draws the faces", () => {
  // Chromium stopped exposing the Shape Detection API by default; without this
  // the faces fall back to a center crop that does not follow anybody.
  assert.ok(CREATE_CALL_WINDOW.includes('enableBlinkFeatures: "FaceDetector"'));
});

test("the call window is not throttled when it is behind other windows", () => {
  // It holds the media, and the float exists to be looked at from another app.
  assert.ok(CREATE_CALL_WINDOW.includes("backgroundThrottling: false"));
});

test("the float never gets a second window, and the old per-state spots are gone", () => {
  // The circles used to be a window of their own, the idle faces a third,
  // and each state of the voice window had a spot of its own to jump to.
  // One window, one anchor: the old channels and the old placements stay dead.
  const src = readFileSync(join(__dirname, "main.js"), "utf8");
  for (const dead of [
    "report-faces-state",
    "set-faces-size",
    "createFacesWindow",
    "facesWindow.",
    "set-faces-window-",
    "get-faces-window-open",
    "circlesPosition",
    "walkiePosition",
    "ringPosition",
    "CALL_WALKIE_",
    "CALL_CIRCLES_",
  ]) {
    assert.ok(!src.includes(dead), `main.js still refers to \`${dead}\``);
  }
});

// Window switchers list the voice window by name, and it wears every shape.
test("the voice window is named for the shape it is in", () => {
  assert.equal(callWindowTitle("panel"), "Codecast Call");
  assert.equal(callWindowTitle("float"), "Codecast Faces");
  assert.equal(callWindowTitle("wall"), "Codecast People");
  assert.equal(callWindowTitle("idle"), "Codecast Voice");
  for (const size of LEGACY_FLOAT_SIZES) assert.equal(callWindowTitle(size), "Codecast Faces", size);
});

// Run: node --test packages/electron/facesWindow.main.test.js
//
// The faces overlay, exercised through main.js itself: the idle team as
// see-through circles over the work, sharing the call circles' spot and
// yielding to them for the length of a minimized call.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness, openCallWindow, openFacesWindow } = require("./mainTestRig");

const loadShell = harness.loadShell;
const readSettings = harness.readSettings;

beforeEach(harness.setup);
afterEach(harness.teardown);

test("the overlay is born see-through, floating, click-through — a circle window from the first frame", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.backgroundColor, "#00000000");
  assert.equal(win.options.hasShadow, false);
  assert.equal(win.options.webPreferences.enableBlinkFeatures, "FaceDetector");
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.match(win.last("loadURL")[0], /\/faces$/);
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: true }]);
  // And it appears without taking the keyboard.
  win.emit("ready-to-show");
  assert.equal(win.did("showInactive").length, 1);
  assert.equal(win.did("show").length, 0);
});

test("opening is a standing arrangement: the open flag persists, closing withdraws it", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  assert.equal(readSettings().facesWindow.open, true);
  rig.handlers.get("close-faces-window")(null);
  assert.equal(readSettings().facesWindow.open, false);
  assert.equal(win.destroyed, true);
});

test("the overlay opens at the call circles' saved spot — one floating thing, one place", () => {
  const rig = loadShell({ callPanelWindow: { circles: { x: 77, y: 33 } } });
  const { win } = openFacesWindow(rig);
  assert.deepEqual(win.last("setPosition"), [77, 33]);
});

test("dragging the overlay moves where the call circles will appear too", async () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  win.setPosition(120, 90);
  win.emit("move");
  // The saver is debounced at 400ms.
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(readSettings().callPanelWindow.circles, { x: 120, y: 90 });
});

test("the overlay yields to a minimized call and returns when the call grows back or ends", () => {
  const rig = loadShell();
  const { win: faces } = openFacesWindow(rig);
  faces.emit("ready-to-show");
  assert.equal(faces.isVisible(), true);

  // A call opens as the STAGE — an ordinary window elsewhere on screen, so
  // the overlay stays.
  const { win: call, sender } = openCallWindow(rig);
  assert.equal(faces.isVisible(), true);

  // Lift click-through first, as a pointer resting on a circle would have.
  rig.handlers.get("set-faces-window-interactive")({ sender: faces.webContents }, true);

  // Minimized to circles: the call takes the spot, the overlay stands down —
  // and its runtime switches reset, because the renderer that normally puts
  // them back sees no mouse while hidden.
  rig.handlers.get("set-call-window-size")(sender, "circles");
  assert.equal(faces.isVisible(), false);
  assert.deepEqual(faces.last("setIgnoreMouseEvents"), [true, { forward: true }]);
  // Hidden, not closed — and still wanted.
  assert.equal(faces.destroyed, false);
  assert.equal(readSettings().facesWindow.open, true);

  // Grown back to the stage: the spot is free again.
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.equal(faces.isVisible(), true);

  // Minimized again, then the call ends: the overlay returns.
  rig.handlers.get("set-call-window-size")(sender, "speaker");
  assert.equal(faces.isVisible(), false);
  call.close();
  assert.equal(faces.isVisible(), true);
});

test("an overlay opened DURING a minimized call waits its turn", () => {
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "circles");
  const { win: faces } = openFacesWindow(rig);
  faces.emit("ready-to-show");
  assert.equal(faces.isVisible(), false);
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.equal(faces.isVisible(), true);
});

test("the overlay sizes the window to its circles, with the zoom applied", () => {
  const rig = loadShell();
  const { win, sender } = openFacesWindow(rig);
  win.zoom = 1.5;
  rig.handlers.get("set-faces-window-content-size")(sender, { width: 100, height: 60 });
  assert.deepEqual(win.getContentSize(), [150, 90]);
  // And the person still cannot drag an edge afterwards.
  assert.equal(win.isResizable(), false);
});

test("width growth keeps the row's centre fixed, and growing then shrinking lands back exactly", () => {
  // The circles are drawn centred, so a top-left-anchored widen (hover adding
  // a chrome wider than one face) would slide every circle away from the
  // pointer that caused it.
  const rig = loadShell({ callPanelWindow: { circles: { x: 700, y: 100 } } });
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-faces-window-content-size")(sender, { width: 60, height: 60 });
  const [x0] = win.getPosition();
  rig.handlers.get("set-faces-window-content-size")(sender, { width: 146, height: 120 });
  assert.equal(win.getPosition()[0], x0 - 43);
  rig.handlers.get("set-faces-window-content-size")(sender, { width: 60, height: 60 });
  assert.equal(win.getPosition()[0], x0);
});

test("a row that grows near the screen edge is pulled back on screen", () => {
  // The window is placed while it is a small seed: parked in the top-right
  // corner, a wide roster would otherwise hang off the display — with no
  // title bar to recover it by.
  const rig = loadShell({ callPanelWindow: { circles: { x: 1460, y: 28 } } });
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-faces-window-content-size")(sender, { width: 600, height: 60 });
  const [x] = win.getPosition();
  // Work area is 1600 wide in the rig; the row's right edge stays inside it.
  assert.equal(x + win.getContentSize()[0] <= 1600, true);
  assert.equal(x >= 0, true);
});

test("only the overlay may drive its own switches — and never the call window's", () => {
  const rig = loadShell();
  const call = openCallWindow(rig);
  const faces = openFacesWindow(rig);
  // An impostor gets nothing.
  const before = faces.win.did("setIgnoreMouseEvents").length;
  rig.handlers.get("set-faces-window-interactive")({ sender: { id: 999 } }, true);
  assert.equal(faces.win.did("setIgnoreMouseEvents").length, before);
  // The overlay's channel resolves the overlay, not the call window.
  rig.handlers.get("set-faces-window-interactive")(call.sender, true);
  assert.equal(faces.win.did("setIgnoreMouseEvents").length, before);
  rig.handlers.get("set-faces-window-interactive")(faces.sender, true);
  assert.deepEqual(faces.win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
});

test("a second open focuses nothing and duplicates nothing — the overlay is a singleton", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  const count = rig.windows.length;
  rig.handlers.get("open-faces-window")(null);
  assert.equal(rig.windows.length, count);
  assert.equal(win.destroyed, false);
});

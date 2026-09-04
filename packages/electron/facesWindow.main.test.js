// Run: node --test packages/electron/facesWindow.main.test.js
//
// The idle faces, exercised through main.js itself: the team as see-through
// circles over the work, as a SHAPE of the voice window rather than a window
// of their own — so a call starting is the photos turning into video in the
// same window, and nothing has to yield to anything.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness, openCallWindow, openFacesWindow } = require("./mainTestRig");

const loadShell = harness.loadShell;
const readSettings = harness.readSettings;

beforeEach(harness.setup);
afterEach(harness.teardown);

test("asking for the faces builds the voice window: see-through, hidden, on /call-panel with no room", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.backgroundColor, "#00000000");
  assert.equal(win.options.hasShadow, false);
  assert.equal(win.options.webPreferences.enableBlinkFeatures, "FaceDetector");
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
  assert.match(win.last("loadURL")[0], /\/call-panel$/);
  // Idle: the window waits, invisible, until the renderer takes a shape.
  win.emit("ready-to-show");
  assert.equal(win.isVisible(), false);
  assert.equal(rig.handlers.get("get-call-window-size")({ sender: win.webContents }), "idle");
});

test("opening is a standing arrangement: the open flag persists, closing withdraws it — and the window stays", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  assert.equal(readSettings().facesWindow.open, true);
  assert.equal(rig.handlers.get("get-faces-window-open")(), true);
  rig.handlers.get("close-faces-window")(null);
  assert.equal(readSettings().facesWindow.open, false);
  assert.equal(rig.handlers.get("get-faces-window-open")(), false);
  // The window is the voice host; the faces were only a shape of it.
  assert.equal(win.destroyed, false);
});

test("the faces shape is a circle shape: floating, click-through, at the call circles' saved spot", () => {
  const rig = loadShell({ callPanelWindow: { circles: { x: 77, y: 33 } } });
  const { win, sender } = openFacesWindow(rig);
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "faces"), "faces");
  assert.deepEqual(win.last("setPosition"), [77, 33]);
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: true }]);
  assert.equal(win.isResizable(), false);
  // Revealed without taking the keyboard: a glance kept beside the work.
  assert.equal(win.did("showInactive").length, 1);
  assert.equal(win.did("show").length, 0);
  // And never remembered as the size the person left a CALL in.
  assert.equal(readSettings().callPanelWindow?.size, undefined);
});

test("dragging the faces moves where the call circles will appear too", async () => {
  const rig = loadShell();
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "faces");
  win.setPosition(120, 90);
  win.emit("move");
  // The saver is debounced at 400ms.
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(readSettings().callPanelWindow.circles, { x: 120, y: 90 });
});

test("a call starting is the same window changing shape — nothing yields, nothing is rebuilt", () => {
  const rig = loadShell();
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "faces");
  const count = rig.windows.length;
  rig.handlers.get("set-call-window-size")(sender, "speaker");
  assert.equal(rig.windows.length, count);
  assert.equal(win.isVisible(), true);
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.equal(rig.windows.length, count);
  // Back to idle: hidden, and the click-through restored so a hidden window
  // never eats a click if it is shown again in a different shape.
  rig.handlers.get("set-call-window-size")(sender, "idle");
  assert.equal(win.isVisible(), false);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
});

test("the faces size the window to their circles, with the zoom applied", () => {
  const rig = loadShell();
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "faces");
  win.zoom = 1.5;
  rig.handlers.get("set-call-window-content-size")(sender, { width: 100, height: 60 });
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
  rig.handlers.get("set-call-window-size")(sender, "faces");
  rig.handlers.get("set-call-window-content-size")(sender, { width: 60, height: 60 });
  const [x0] = win.getPosition();
  rig.handlers.get("set-call-window-content-size")(sender, { width: 146, height: 120 });
  assert.equal(win.getPosition()[0], x0 - 43);
  rig.handlers.get("set-call-window-content-size")(sender, { width: 60, height: 60 });
  assert.equal(win.getPosition()[0], x0);
});

test("a row that grows near the screen edge is pulled back on screen", () => {
  const rig = loadShell({ callPanelWindow: { circles: { x: 1460, y: 28 } } });
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "faces");
  rig.handlers.get("set-call-window-content-size")(sender, { width: 600, height: 60 });
  const [x] = win.getPosition();
  // Work area is 1600 wide in the rig; the row's right edge stays inside it.
  assert.equal(x + win.getContentSize()[0] <= 1600, true);
  assert.equal(x >= 0, true);
});

test("a second open focuses nothing and duplicates nothing — the voice window is a singleton", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  const count = rig.windows.length;
  rig.handlers.get("open-faces-window")(null);
  assert.equal(rig.windows.length, count);
  assert.equal(win.destroyed, false);
  // And a call opening finds the same window rather than building a second.
  openCallWindow(rig);
  assert.equal(rig.windows.length, count);
});

test("every window is told whether the faces are wanted, so the toggle reads the same everywhere", async () => {
  const rig = loadShell();
  const roles = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "window-role") roles.push(payload);
  };
  openFacesWindow(rig);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].facesOverlay, true);
  rig.handlers.get("close-faces-window")(null);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].facesOverlay, false);
});

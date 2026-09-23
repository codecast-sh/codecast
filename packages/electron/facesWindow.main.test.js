// Run: node --test packages/electron/facesWindow.main.test.js
//
// The float, exercised through main.js itself: the face row as see-through
// glass over the work, a SHAPE of the voice window rather than a window of
// its own, anchored to ONE remembered corner it grows away from. A ring, a
// burst and a call are the same shape drawing different states, so across
// all of them the window's anchor does not move.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness, openCallWindow, openFacesWindow } = require("./mainTestRig");

const loadShell = harness.loadShell;
const readSettings = harness.readSettings;

beforeEach(harness.setup);
afterEach(harness.teardown);

// The rig's work area is 1600x1000; the default anchor is 28px in from the
// top right of it.
const DEFAULT_ANCHOR = { x: 1572, y: 28 };

/** The screen point of a window's `corner`, read off its bounds. */
function cornerOf(win, corner) {
  const b = win.getBounds();
  const [v, h] = corner.split("-");
  return { x: h === "right" ? b.x + b.width : b.x, y: v === "bottom" ? b.y + b.height : b.y };
}

function bootHost(rig) {
  const { win, sender } = openFacesWindow(rig);
  rig.handlers.get("voice-host-ready")(sender);
  return { win, sender };
}

const setSize = (rig, sender, size) => rig.handlers.get("set-call-window-size")(sender, size);
const report = (rig, sender, width, height) =>
  rig.handlers.get("set-call-window-content-size")(sender, { width, height });

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
  assert.equal(rig.handlers.get("get-call-window-size")(rig.event(win.webContents)), "idle");
});

test("popping the row out is a standing arrangement: the flag persists, closing withdraws it, the window stays", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  assert.equal(readSettings().facesWindow.open, true);
  rig.handlers.get("close-faces-window")(rig.event());
  assert.equal(readSettings().facesWindow.open, false);
  // The window is the voice host; the float was only a shape of it.
  assert.equal(win.destroyed, false);
});

test("the float is above the work, on every desktop, click-through, revealed without focus", () => {
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  assert.equal(setSize(rig, sender, "float"), "float");
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: false, skipTransformProcessType: true }]);
  assert.equal(win.isResizable(), false);
  // A glance kept beside the work: shown, never focused.
  assert.equal(win.did("showInactive").length, 1);
  assert.equal(win.did("show").length, 0);
  assert.equal(win.did("focus").length, 0);
  // Hung from the default anchor: its top right corner is the anchor.
  assert.deepEqual(cornerOf(win, "top-right"), DEFAULT_ANCHOR);
});

test("the anchor does not move across ring, walkie, call and idle", () => {
  // The whole point. Each state used to have a spot of its own and the
  // window jumped between them; now every state is the float at one anchor,
  // and the row grows away from it as the card and the faces come and go.
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  const seen = [];
  const step = (label, fn) => {
    fn();
    seen.push([label, cornerOf(win, "top-right"), win.isVisible()]);
  };
  step("ring", () => {
    setSize(rig, sender, "float");
    report(rig, sender, 336, 132);
  });
  step("walkie", () => report(rig, sender, 336, 196));
  step("call", () => report(rig, sender, 420, 88));
  step("idle", () => setSize(rig, sender, "idle"));
  step("float again", () => {
    setSize(rig, sender, "float");
    report(rig, sender, 154, 80);
  });
  for (const [label, corner, visible] of seen) {
    assert.deepEqual(corner, DEFAULT_ANCHOR, label);
    assert.equal(visible, label !== "idle", label);
  }
  // And the sizes really did change under the fixed corner.
  assert.deepEqual(win.getContentSize(), [154, 80]);
});

test("the names the states used to go by are the float, at the same anchor", () => {
  // An older web build asks for ring, walkie, circles; a newer one asks for
  // float. Same shape, same place: the second ask moves nothing.
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  assert.equal(setSize(rig, sender, "ring"), "float");
  const moves = win.did("setPosition").length;
  for (const legacy of ["walkie", "circles", "speaker", "tiny", "faces", "float"]) {
    assert.equal(setSize(rig, sender, legacy), "float", legacy);
  }
  assert.equal(win.did("setPosition").length, moves);
  assert.deepEqual(cornerOf(win, "top-right"), DEFAULT_ANCHOR);
  // Never remembered as anything but the float.
  assert.equal(readSettings().callPanelWindow.size, "float");
});

test("growth goes away from the anchored corner, and a grow then shrink lands back exactly", () => {
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  report(rig, sender, 100, 80);
  const [x0, y0] = win.getPosition();
  // Wider and taller: the window extends left and down from the top right.
  report(rig, sender, 340, 200);
  assert.deepEqual(win.getPosition(), [x0 - 240, y0]);
  report(rig, sender, 100, 80);
  assert.deepEqual(win.getPosition(), [x0, y0]);
});

test("a dragged float remembers the corner it was left in, and comes back growing from it", async () => {
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  report(rig, sender, 200, 80);
  // Dragged into the bottom right of the 1600x1000 work area.
  win.setPosition(1380, 900);
  win.emit("move");
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(readSettings().callPanelWindow.float, { x: 1580, y: 980, corner: "bottom-right" });
  // Hidden and shown again: hung from that anchor by its bottom right corner.
  setSize(rig, sender, "idle");
  setSize(rig, sender, "float");
  report(rig, sender, 200, 80);
  assert.deepEqual(cornerOf(win, "bottom-right"), { x: 1580, y: 980 });
  // And growth now goes up and to the left.
  report(rig, sender, 340, 200);
  assert.deepEqual(cornerOf(win, "bottom-right"), { x: 1580, y: 980 });
  assert.deepEqual(win.getPosition(), [1240, 780]);
});

test("a saved anchor from a display that is gone is pulled back on screen", () => {
  const rig = loadShell({ callPanelWindow: { float: { x: 4000, y: -300, corner: "top-right" } } });
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  const [x, y] = win.getPosition();
  const [w, h] = win.getContentSize();
  assert.ok(x >= 0 && x + w <= 1600, `x ${x}`);
  assert.ok(y >= 0 && y + h <= 1000, `y ${y}`);
});

test("a row that grows near the screen edge is pulled back on screen", () => {
  const rig = loadShell({ callPanelWindow: { float: { x: 100, y: 28, corner: "top-right" } } });
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  report(rig, sender, 600, 60);
  const [x] = win.getPosition();
  assert.equal(x, 0);
  assert.equal(x + win.getContentSize()[0] <= 1600, true);
});

test("the float sizes the window to its row, with the zoom applied", () => {
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  win.zoom = 1.5;
  report(rig, sender, 100, 60);
  assert.deepEqual(win.getContentSize(), [150, 90]);
  // And the person still cannot drag an edge afterwards.
  assert.equal(win.isResizable(), false);
});

test("a call opening the stage, and the stage going back to the float, rebuilds nothing", () => {
  const rig = loadShell();
  const { win, sender } = bootHost(rig);
  setSize(rig, sender, "float");
  const count = rig.windows.length;
  setSize(rig, sender, "panel");
  assert.equal(rig.windows.length, count);
  assert.equal(win.isVisible(), true);
  setSize(rig, sender, "float");
  assert.equal(rig.windows.length, count);
  // Back to idle: hidden, and the click-through restored so a hidden window
  // never eats a click if it is shown again in a different shape.
  setSize(rig, sender, "idle");
  assert.equal(win.isVisible(), false);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
});

test("a second open focuses nothing and duplicates nothing: the voice window is a singleton", () => {
  const rig = loadShell();
  const { win } = openFacesWindow(rig);
  const count = rig.windows.length;
  rig.handlers.get("open-faces-window")(rig.event());
  assert.equal(rig.windows.length, count);
  assert.equal(win.destroyed, false);
  // And a call opening finds the same window rather than building a second.
  openCallWindow(rig);
  assert.equal(rig.windows.length, count);
});

test("every window is told whether the row is popped out, so the header's chip reads the same everywhere", async () => {
  const rig = loadShell();
  const roles = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "window-role") roles.push(payload);
  };
  openFacesWindow(rig);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].facesOverlay, true);
  rig.handlers.get("close-faces-window")(rig.event());
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].facesOverlay, false);
});

test("a click on the float is not the app taking focus", async () => {
  // The host shows the float for a ring or a burst only while the app is
  // behind another window. The float is an app window; if reaching for a
  // face on it counted as the app being focused, the host would hide the
  // float under the pointer.
  const rig = loadShell();
  const roles = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "window-role") roles.push(payload);
  };
  const { win } = bootHost(rig);
  win.isFocused = () => true;
  rig.listeners.get("browser-window-focus")?.({}, win);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].appFocused, false);
  rig.mainWindow.isFocused = () => true;
  rig.listeners.get("browser-window-focus")?.({}, rig.mainWindow);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(roles[roles.length - 1].appFocused, true);
});

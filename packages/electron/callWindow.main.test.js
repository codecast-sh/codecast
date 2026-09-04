// Run: node --test packages/electron/callWindow.main.test.js
//
// The call window, exercised through main.js itself rather than described.
//
// Its one irreversible property is decided at CONSTRUCTION — `transparent` and
// `frame` cannot be changed afterwards, which is the whole reason the stage and
// the circles had to become one window — and the rest of it is a handful of
// runtime calls that must move together: float, click-through, resizable,
// bounds. Both are ordinary function calls, so this loads main.js against the
// shared recorder rig (mainTestRig.js) and reads what it asked for.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness, cursorReads, openCallWindow } = require("./mainTestRig");

const loadShell = harness.loadShell;
const readSettings = harness.readSettings;

beforeEach(harness.setup);
afterEach(harness.teardown);

test("the window is born frameless and see-through, whatever size it opens in", () => {
  const rig = loadShell();
  const { win } = openCallWindow(rig);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.backgroundColor, "#00000000");
  assert.equal(win.options.hasShadow, false);
  // No traffic lights to sit under, and no OS title bar: the stage's own header
  // row is the drag surface and its own button closes the window.
  assert.equal(win.options.titleBarStyle, undefined);
  assert.equal(win.options.trafficLightPosition, undefined);
  // It draws face circles now, so the flag that used to be on the faces window
  // has to be here.
  assert.equal(win.options.webPreferences.enableBlinkFeatures, "FaceDetector");
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
});

test("the stage is an ordinary window: no float, no click-through, resizable", () => {
  const rig = loadShell();
  const { win } = openCallWindow(rig);
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [false, { visibleOnFullScreen: true }]);
  assert.equal(win.isResizable(), true);
  win.emit("ready-to-show");
  assert.equal(win.did("show").length, 1);
  assert.equal(win.did("showInactive").length, 0);
});

test("every circle size floats over the work, lets the mouse through and cannot be dragged by an edge", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  for (const size of ["circles", "speaker", "tiny"]) {
    rig.handlers.get("set-call-window-size")(sender, size);
    assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"], size);
    assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }], size);
    assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: true }], size);
    assert.equal(win.isResizable(), false, size);
  }
});

test("going back to the stage undoes all three, together", () => {
  // Half-undone is each its own bug: a stage that still lets clicks through is
  // unusable, and one still floating sits over every other window.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "tiny");
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
  assert.equal(win.isResizable(), true);
});

test("the size the renderer asked for is the size it is told it got", () => {
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "speaker"), "speaker");
  assert.equal(rig.handlers.get("get-call-window-size")(sender), "speaker");
});

test("an unknown size lands on the stage, never on an invisible window", () => {
  // It arrives over IPC from a renderer, on a channel that changes what the
  // window IS. A name nobody recognizes has to fail to something a person can
  // see and click.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "circles");
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "faces"), "panel");
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
});

test("only the call window may reshape itself", () => {
  const rig = loadShell();
  openCallWindow(rig);
  const impostor = { sender: { id: 99 } };
  assert.equal(rig.handlers.get("set-call-window-size")(impostor, "circles"), null);
  assert.equal(rig.handlers.get("get-call-window-size")(impostor), null);
});

test("the size is remembered per machine and restored on the next popout", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "tiny");
  assert.equal(readSettings().callPanelWindow.size, "tiny");
  win.close();

  // A fresh launch, reading the file the last one wrote.
  const next = loadShell(readSettings());
  const reopened = openCallWindow(next);
  assert.equal(next.handlers.get("get-call-window-size")(reopened.sender), "tiny");
  // Seeded into the URL too, so the first paint is already the circle rather
  // than a stage that snaps a frame later.
  assert.match(reopened.win.last("loadURL")[0], /size=tiny/);
  // And it opens without taking the keyboard: a circle is a glance you keep
  // beside your work.
  reopened.win.emit("ready-to-show");
  assert.equal(reopened.win.did("showInactive").length, 1);
  assert.equal(reopened.win.did("show").length, 0);
});

test("the stage's bounds and the circles' position are remembered separately", () => {
  // One window, two places. Saving one over the other would drag each size to
  // where the other was last left.
  const rig = loadShell({ callPanelWindow: { bounds: { x: 200, y: 120, width: 900, height: 600 } } });
  const { win, sender } = openCallWindow(rig);
  assert.deepEqual(win.getBounds(), { x: 200, y: 120, width: 900, height: 600 });

  rig.handlers.get("set-call-window-size")(sender, "circles");
  win.setPosition(40, 40);
  win.close();
  const saved = readSettings().callPanelWindow;
  assert.deepEqual(saved.circles, { x: 40, y: 40 });
  assert.deepEqual(saved.bounds, { x: 200, y: 120, width: 900, height: 600 });
});

test("the circles size the window to themselves; the stage does not", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  // In the stage the person's own bounds are the answer — a renderer resizing
  // the window under them would be the window fighting the hand on its edge.
  const stage = win.getContentSize();
  rig.handlers.get("set-call-window-content-size")(sender, { width: 300, height: 300 });
  assert.deepEqual(win.getContentSize(), stage);
  assert.deepEqual(win.getContentSize(), [960, 640]);

  rig.handlers.get("set-call-window-size")(sender, "circles");
  rig.handlers.get("set-call-window-content-size")(sender, { width: 224, height: 112 });
  assert.deepEqual(win.getContentSize(), [224, 112]);
  // And the flag goes straight back: the person still cannot drag an edge.
  assert.equal(win.isResizable(), false);
});

test("a nonsense content size is ignored rather than applied", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "speaker");
  const before = win.getContentSize();
  for (const bad of [null, { width: 0, height: 10 }, { width: 9000, height: 9000 }, { width: "x", height: 10 }]) {
    rig.handlers.get("set-call-window-content-size")(sender, bad);
  }
  assert.deepEqual(win.getContentSize(), before);
});

test("click-through is refused in the stage, where it would make the window unclickable", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  const before = win.did("setIgnoreMouseEvents").length;
  rig.handlers.get("set-call-window-interactive")(sender, false);
  assert.equal(win.did("setIgnoreMouseEvents").length, before);
});

test("click-through follows the renderer's hit test in a circle size", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "circles");
  rig.handlers.get("set-call-window-interactive")(sender, true);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
  rig.handlers.get("set-call-window-interactive")(sender, false);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
});

test("closing with a live call hides the window and does not pour the huddle into the main one", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig, "session:abc", { mic: true, camera: true });
  rig.handlers.get("report-call-panel-state")(sender, {
    room: "session:abc",
    mic: true,
    camera: true,
    scribe: true,
  });
  const sent = [];
  rig.mainWindow.webContents.send = (channel, payload) => sent.push([channel, payload]);
  win.close();
  assert.equal(win.destroyed, false);
  assert.equal(win.isVisible(), false);
  assert.equal(win.did("hide").length, 1);
  assert.deepEqual(sent, []);
});

test("showing a hidden huddle raises the same window", () => {
  const rig = loadShell();
  const { win } = openCallWindow(rig, "session:abc");
  win.close();
  assert.equal(win.isVisible(), false);
  assert.equal(rig.handlers.get("show-call-panel")(), true);
  assert.equal(win.isVisible(), true);
  assert.equal(win.did("show").length, 1);
});

test("a hang-up hands nothing back", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  const sent = [];
  rig.mainWindow.webContents.send = (channel) => sent.push(channel);
  rig.handlers.get("close-call-panel")(sender, { ended: true });
  assert.deepEqual(sent, []);
});

test("changing size hands nothing back, because the window never closed", () => {
  // The whole point of one window with three sizes: the media stays put, so
  // there is no moment where the call is between windows.
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  const sent = [];
  rig.mainWindow.webContents.send = (channel) => sent.push(channel);
  rig.handlers.get("set-call-window-size")(sender, "circles");
  rig.handlers.get("set-call-window-size")(sender, "speaker");
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.deepEqual(sent, []);
});

test("dragging by a circle is refused in the stage, which drags by its header row", () => {
  // The stage uses a real `-webkit-app-region: drag` region, handled by the
  // window manager. Following the cursor from here as well would be two things
  // moving one window.
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  cursorReads.count = 0;
  rig.handlers.get("set-call-window-dragging")(sender, true);
  assert.equal(cursorReads.count, 0);
});

test("dragging by a circle has the shell follow the cursor, and stops when told", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "speaker");
  cursorReads.count = 0;
  rig.handlers.get("set-call-window-dragging")(sender, true);
  // One read to take the offset between the cursor and the window's corner.
  assert.equal(cursorReads.count, 1);
  rig.handlers.get("set-call-window-dragging")(sender, false);
  // And the drag holds no timer once it is over: a window that kept following
  // the cursor for the rest of a call has no way out short of hanging up.
  const before = win.did("setPosition").length;
  cursorReads.count = 0;
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.equal(cursorReads.count, 0);
      assert.equal(win.did("setPosition").length, before);
      resolve();
    }, 40),
  );
});

test("a zoomed page still gets a window the size of its circles", () => {
  // The renderer measures in CSS pixels; the window is sized in device-
  // independent ones. At 1.5x a 112px row needs a 168px window, and a window
  // sized to 112 would clip the faces it exists to show.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "circles");
  win.webContents.setZoomFactor(1.5);
  rig.handlers.get("set-call-window-content-size")(sender, { width: 112, height: 112 });
  assert.deepEqual(win.getContentSize(), [168, 168]);
});

test("an opener may ask for a size, and the window is born in it", () => {
  // The walkie card's "Float faces over my work" wants circles, not a stage
  // that shrinks a frame later. The size is remembered like any other.
  const rig = loadShell({ callPanelWindow: { size: "panel" } });
  rig.handlers.get("open-call-panel")(null, "dm:a:b", { mic: true, size: "speaker" });
  const win = rig.windows[rig.windows.length - 1];
  assert.match(win.last("loadURL")[0], /size=speaker/);
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.equal(readSettings().callPanelWindow.size, "speaker");
  // Asked again on the window that exists, the shape changes in place.
  rig.handlers.get("open-call-panel")(null, "dm:a:b", { size: "panel" });
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.equal(win.isResizable(), true);
});

test("showing a huddle finds the regular window hosting it when no panel exists", () => {
  const rig = loadShell();
  rig.mainWindow.webContents.once = () => {};
  rig.handlers.get("report-window-state")({ sender: rig.mainWindow.webContents }, { inCall: true });
  assert.equal(rig.handlers.get("show-call-panel")(), true);
  assert.equal(rig.mainWindow.did("show").length, 1);
  assert.equal(rig.mainWindow.did("focus").length, 1);
});

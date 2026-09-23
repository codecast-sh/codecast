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
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [false, { visibleOnFullScreen: false, skipTransformProcessType: true }]);
  assert.equal(win.isResizable(), true);
  win.emit("ready-to-show");
  assert.equal(win.did("show").length, 1);
  assert.equal(win.did("showInactive").length, 0);
});

test("the float sits over the work, lets the mouse through and cannot be dragged by an edge", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [true, { forward: true }]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: false, skipTransformProcessType: true }]);
  assert.equal(win.isResizable(), false);
});

test("going back to the stage undoes all three, together", () => {
  // Half-undone is each its own bug: a stage that still lets clicks through is
  // unusable, and one still floating sits over every other window.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
  assert.equal(win.isResizable(), true);
});

test("the size the renderer asked for is the size it is told it got", () => {
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "float"), "float");
  assert.equal(rig.handlers.get("get-call-window-size")(sender), "float");
});

test("an unknown size lands on the stage, never on an invisible window", () => {
  // It arrives over IPC from a renderer, on a channel that changes what the
  // window IS. A name nobody recognizes has to fail to something a person can
  // see and click.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "banana"), "panel");
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
});

test("only the call window may reshape itself", () => {
  const rig = loadShell();
  openCallWindow(rig);
  const impostor = { sender: { id: 99 } };
  assert.equal(rig.handlers.get("set-call-window-size")(impostor, "float"), null);
  assert.equal(rig.handlers.get("get-call-window-size")(impostor), null);
});

test("the size is remembered per machine and restored on the next popout", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
  assert.equal(readSettings().callPanelWindow.size, "float");
  win.close();

  // A fresh launch, reading the file the last one wrote.
  const next = loadShell(readSettings());
  const reopened = openCallWindow(next);
  assert.equal(next.handlers.get("get-call-window-size")(reopened.sender), "float");
  // Seeded into the URL too, so the first paint is already the float rather
  // than a stage that snaps a frame later.
  assert.match(reopened.win.last("loadURL")[0], /size=float/);
  // And it opens without taking the keyboard: the float is a glance you keep
  // beside your work.
  reopened.win.emit("ready-to-show");
  assert.equal(reopened.win.did("showInactive").length, 1);
  assert.equal(reopened.win.did("show").length, 0);
});

test("the stage's bounds and the float's anchor are remembered separately", () => {
  // One window, two places. Saving one over the other would drag each size to
  // where the other was last left.
  const rig = loadShell({ callPanelWindow: { bounds: { x: 200, y: 120, width: 900, height: 600 } } });
  const { win, sender } = openCallWindow(rig);
  assert.deepEqual(win.getBounds(), { x: 200, y: 120, width: 900, height: 600 });

  rig.handlers.get("set-call-window-size")(sender, "float");
  win.setPosition(40, 40);
  win.close();
  const saved = readSettings().callPanelWindow;
  // Left in the top left of the display: anchored by that corner.
  assert.deepEqual(saved.float, { x: 40, y: 40, corner: "top-left" });
  assert.deepEqual(saved.bounds, { x: 200, y: 120, width: 900, height: 600 });
});

test("the float sizes the window to itself; the stage does not", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  // In the stage the person's own bounds are the answer — a renderer resizing
  // the window under them would be the window fighting the hand on its edge.
  const stage = win.getContentSize();
  rig.handlers.get("set-call-window-content-size")(sender, { width: 300, height: 300 });
  assert.deepEqual(win.getContentSize(), stage);
  assert.deepEqual(win.getContentSize(), [960, 640]);

  rig.handlers.get("set-call-window-size")(sender, "float");
  rig.handlers.get("set-call-window-content-size")(sender, { width: 224, height: 112 });
  assert.deepEqual(win.getContentSize(), [224, 112]);
  // And the flag goes straight back: the person still cannot drag an edge.
  assert.equal(win.isResizable(), false);
});

test("a nonsense content size is ignored rather than applied", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
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

test("click-through follows the renderer's hit test in the float", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
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
  assert.equal(rig.handlers.get("show-call-panel")(rig.event()), true);
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
  // The whole point of one window with two sizes: the media stays put, so
  // there is no moment where the call is between windows.
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  const sent = [];
  rig.mainWindow.webContents.send = (channel) => sent.push(channel);
  rig.handlers.get("set-call-window-size")(sender, "float");
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.deepEqual(sent, []);
});

test("dragging by a face is refused in the stage, which drags by its header row", () => {
  // The stage uses a real `-webkit-app-region: drag` region, handled by the
  // window manager. Following the cursor from here as well would be two things
  // moving one window.
  const rig = loadShell();
  const { sender } = openCallWindow(rig);
  cursorReads.count = 0;
  rig.handlers.get("set-call-window-dragging")(sender, true);
  assert.equal(cursorReads.count, 0);
});

test("dragging by a face has the shell follow the cursor, and stops when told", () => {
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
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

test("a zoomed page still gets a window the size of its faces", () => {
  // The renderer measures in CSS pixels; the window is sized in device-
  // independent ones. At 1.5x a 112px row needs a 168px window, and a window
  // sized to 112 would clip the faces it exists to show.
  const rig = loadShell();
  const { win, sender } = openCallWindow(rig);
  rig.handlers.get("set-call-window-size")(sender, "float");
  win.webContents.setZoomFactor(1.5);
  rig.handlers.get("set-call-window-content-size")(sender, { width: 112, height: 112 });
  assert.deepEqual(win.getContentSize(), [168, 168]);
});

test("an opener may ask for a size, and the window is born in it", () => {
  // An opener that wants the faces over the work asks for the float, not a
  // stage that shrinks a frame later. The size is remembered like any other.
  const rig = loadShell({ callPanelWindow: { size: "panel" } });
  rig.handlers.get("open-call-panel")(rig.event(), "dm:a:b", { mic: true, size: "float" });
  const win = rig.windows[rig.windows.length - 1];
  assert.match(win.last("loadURL")[0], /size=float/);
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.equal(readSettings().callPanelWindow.size, "float");
  // Asked again on the window that exists, the shape changes in place.
  rig.handlers.get("open-call-panel")(rig.event(), "dm:a:b", { size: "panel" });
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.equal(win.isResizable(), true);
});

test("showing a huddle finds the regular window hosting it when no panel exists", () => {
  const rig = loadShell();
  rig.mainWindow.webContents.once = () => {};
  rig.handlers.get("report-window-state")(rig.event(rig.mainWindow.webContents), { inCall: true });
  assert.equal(rig.handlers.get("show-call-panel")(rig.event()), true);
  assert.equal(rig.mainWindow.did("show").length, 1);
  assert.equal(rig.mainWindow.did("focus").length, 1);
});

// ── The voice host ────────────────────────────────────────────────────────
//
// The window is persistent: built at boot with no room, it holds the walkie's
// ear and takes rooms as commands. A burst becoming a call is this window
// changing shape, so nothing here may ever reload it or build a second one.

/** The voice window as the app boots it: no room, idle, hidden. */
function bootVoiceWindow(rig) {
  rig.handlers.get("open-faces-window")(rig.event());
  const win = rig.windows[rig.windows.length - 1];
  const sender = rig.event(win.webContents);
  return { win, sender };
}

function declareHost(rig, sender) {
  rig.handlers.get("voice-host-ready")(sender);
}

test("a host takes a room as a command — the window is never reloaded under it", () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  const sent = [];
  win.webContents.send = (channel, payload) => sent.push([channel, payload]);
  const loads = win.did("loadURL").length;
  rig.handlers.get("open-call-panel")(rig.event(), "dm:a:b", { mic: true, size: "float" });
  assert.equal(win.did("loadURL").length, loads);
  assert.deepEqual(sent, [
    ["call-panel-open", { room: "dm:a:b", mic: true, camera: false, scribe: false, ring: false, size: "float" }],
  ]);
  // The shell does not move the window itself: the host reshapes once it has
  // the room, so the row it may be showing is not yanked mid-burst.
  assert.equal(rig.handlers.get("get-call-window-size")(sender), "idle");
});

test("before the renderer declares itself, a room still reaches it the older way", () => {
  // The first second after boot, and an older web build: a room in the URL is
  // the one form every renderer understands.
  const rig = loadShell();
  const { win } = bootVoiceWindow(rig);
  rig.handlers.get("open-call-panel")(rig.event(), "dm:a:b", { mic: true });
  assert.match(win.last("loadURL")[0], /call-panel\?room=dm%3Aa%3Ab&mic=1/);
});

test("a host's hang-up hides the window; it is destroyed only by quitting", () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.equal(win.isVisible(), true);
  rig.handlers.get("close-call-panel")(sender, { ended: true });
  assert.equal(win.destroyed, false);
  assert.equal(win.isVisible(), false);
});

test("the host is told the shape it is in and the call shape the person chose", () => {
  const rig = loadShell({ callPanelWindow: { size: "panel" } });
  const { sender } = bootVoiceWindow(rig);
  assert.deepEqual(rig.handlers.get("get-voice-window-state")(sender), { size: "idle", callSize: "panel" });
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "float"), "float");
  // The float is a call shape the person can leave a call in, so it is the
  // one the next call opens in.
  assert.deepEqual(rig.handlers.get("get-voice-window-state")(sender), { size: "float", callSize: "float" });
  // The wall is not: a call never opens as the buddy list.
  rig.handlers.get("set-call-window-size")(sender, "wall");
  assert.deepEqual(rig.handlers.get("get-voice-window-state")(sender), { size: "wall", callSize: "float" });
});

test("commands from other windows reach the host, and nobody when there is none", () => {
  const rig = loadShell();
  assert.equal(rig.handlers.get("voice-command")(rig.event(), "startBurst", ["ch1", "dm:a:b"]), false);
  const { win, sender } = bootVoiceWindow(rig);
  // Built but not yet declared: the renderer may still be loading, or old.
  assert.equal(rig.handlers.get("voice-command")(rig.event(), "startBurst", ["ch1", "dm:a:b"]), false);
  declareHost(rig, sender);
  const sent = [];
  win.webContents.send = (channel, payload) => sent.push([channel, payload]);
  assert.equal(rig.handlers.get("voice-command")(rig.event(), "startBurst", ["ch1", "dm:a:b"]), true);
  assert.deepEqual(sent, [["voice-command", { cmd: "startBurst", args: ["ch1", "dm:a:b"] }]]);
  // A command with no name, or with arguments that are not a list, is dropped.
  assert.equal(rig.handlers.get("voice-command")(rig.event(), "", []), false);
  rig.handlers.get("voice-command")(rig.event(), "endBurst", "not-a-list");
  assert.deepEqual(sent[sent.length - 1], ["voice-command", { cmd: "endBurst", args: [] }]);
});

test("the host's mirror reaches every other window, and a window that opens later gets the last one", () => {
  const rig = loadShell();
  // A people window of its own, from before the host declared (with a host
  // the buddy list is the host's wall, not a window).
  rig.handlers.get("open-people-window")(rig.event());
  const people = rig.windows[rig.windows.length - 1];
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  const main = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "voice-mirror") main.push(payload);
  };
  const own = [];
  win.webContents.send = (channel, payload) => own.push([channel, payload]);
  const mirror = { walkie: { sending: null }, call: { phase: "idle" } };
  rig.handlers.get("voice-mirror")(sender, mirror);
  assert.deepEqual(main, [mirror]);
  // Never back to the host itself.
  assert.deepEqual(own, []);
  // Only the host may mirror.
  rig.handlers.get("voice-mirror")({ sender: { id: 999 } }, { walkie: null });
  assert.deepEqual(main, [mirror]);

  // A window reporting its state for the first time gets the last mirror in
  // reply, so its talk keys do not start blank.
  const late = [];
  people.webContents.send = (channel, payload) => {
    if (channel === "voice-mirror") late.push(payload);
  };
  people.webContents.once = () => {};
  rig.handlers.get("report-window-state")(rig.event(people.webContents), { active: "/people", open: [] });
  assert.deepEqual(late, [mirror]);
});

test("the host's camera frames reach every other window and are never kept for a late one", () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  const main = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "voice-frames") main.push(payload);
  };
  const own = [];
  win.webContents.send = (channel, payload) => own.push([channel, payload]);
  const frames = { "u-ann": "data:image/jpeg;base64,AAAA" };
  rig.handlers.get("voice-frames")(sender, frames);
  assert.deepEqual(main, [frames]);
  // Never back to the host, and only the host may send them.
  assert.deepEqual(own, []);
  rig.handlers.get("voice-frames")({ sender: { id: 999 } }, { "u-bo": "data:x" });
  assert.deepEqual(main, [frames]);
  // A frame is a moment, not a state: a window that opens later gets the next
  // one, never a replay.
  rig.handlers.get("open-people-window")(rig.event());
  const people = rig.windows[rig.windows.length - 1];
  const late = [];
  people.webContents.send = (channel, payload) => {
    if (channel === "voice-frames") late.push(payload);
  };
  people.webContents.once = () => {};
  rig.handlers.get("report-window-state")(rig.event(people.webContents), { active: "/people", open: [] });
  assert.deepEqual(late, []);
});

test("the call lives in the voice window only while it hosts a room", async () => {
  const rig = loadShell();
  const roles = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "window-role") roles.push(payload);
  };
  const { sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  await new Promise((r) => setTimeout(r, 60));
  let role = roles[roles.length - 1];
  assert.equal(role.voiceWindow, true);
  assert.equal(role.callPanel, false);
  // A room arrives: the other windows stand down from their docks.
  rig.handlers.get("report-call-panel-state")(sender, { room: "dm:a:b", mic: true, camera: false, scribe: false });
  await new Promise((r) => setTimeout(r, 60));
  role = roles[roles.length - 1];
  assert.equal(role.callPanel, true);
  // And a hang-up gives them back their surfaces, while the host stays.
  rig.handlers.get("report-call-panel-state")(sender, { room: null, mic: false, camera: false, scribe: false });
  await new Promise((r) => setTimeout(r, 60));
  role = roles[roles.length - 1];
  assert.equal(role.callPanel, false);
  assert.equal(role.voiceWindow, true);
});

test("raising the huddle on a host tells the host, which takes the call's shape itself", () => {
  // The host derives its shape from what is happening; the shell moving it
  // would fight that. A host hiding the call behind the wall is told to stop.
  const rig = loadShell({ callPanelWindow: { size: "float" } });
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  const sent = [];
  win.webContents.send = (channel) => sent.push(channel);
  rig.handlers.get("report-call-panel-state")(sender, { room: "dm:a:b", mic: true, camera: false, scribe: false });
  rig.handlers.get("set-call-window-size")(sender, "wall");
  assert.equal(rig.handlers.get("show-call-panel")(rig.event()), true);
  assert.deepEqual(sent, ["call-panel-show"]);
  assert.equal(rig.handlers.get("get-call-window-size")(sender), "wall");
  // In a call shape that was merely closed, the shell reveals it as well.
  rig.handlers.get("set-call-window-size")(sender, "float");
  win.hide();
  assert.equal(rig.handlers.get("show-call-panel")(rig.event()), true);
  assert.equal(win.isVisible(), true);
});

// ── The wall ──────────────────────────────────────────────────────────────

test("with a host, asking for the people window asks the host for the wall — and puts the faces away", async () => {
  const rig = loadShell({ facesWindow: { open: true } });
  const roles = [];
  rig.mainWindow.webContents.send = (channel, payload) => {
    if (channel === "window-role") roles.push(payload);
  };
  const { sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  const count = rig.windows.length;
  rig.handlers.get("open-people-window")(rig.event());
  // No second window.
  assert.equal(rig.windows.length, count);
  assert.equal(readSettings().peopleWindow.open, true);
  assert.equal(readSettings().facesWindow.open, false);
  await new Promise((r) => setTimeout(r, 60));
  const role = roles[roles.length - 1];
  assert.equal(role.peopleWall, true);
  assert.equal(role.facesOverlay, false);
  assert.equal(role.peopleWindow, false);
  // Putting it away.
  rig.handlers.get("close-people-window")(rig.event());
  assert.equal(readSettings().peopleWindow.open, false);
  // And asking for the faces puts the wall away in turn.
  rig.handlers.get("open-people-window")(rig.event());
  rig.handlers.get("open-faces-window")(rig.event());
  assert.equal(readSettings().peopleWindow.open, false);
  assert.equal(readSettings().facesWindow.open, true);
});

test("without a host, the people window is still a window of its own", () => {
  const rig = loadShell();
  const count = rig.windows.length;
  rig.handlers.get("open-people-window")(rig.event());
  assert.equal(rig.windows.length, count + 1);
  assert.match(rig.windows[rig.windows.length - 1].last("loadURL")[0], /\/people$/);
});

test("the wall takes the people window's rectangle, floats by its pin, and is resized by its edges", () => {
  const rig = loadShell({ peopleWindow: { bounds: { x: 100, y: 80, width: 340, height: 700 }, alwaysOnTop: true } });
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  assert.equal(rig.handlers.get("set-call-window-size")(sender, "wall"), "wall");
  assert.deepEqual(win.getBounds(), { x: 100, y: 80, width: 340, height: 700 });
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.deepEqual(win.last("setIgnoreMouseEvents"), [false, { forward: true }]);
  assert.equal(win.isResizable(), true);
  // The renderer may not size it: the person's own bounds are the answer.
  rig.handlers.get("set-call-window-content-size")(sender, { width: 50, height: 50 });
  assert.deepEqual(win.getBounds(), { x: 100, y: 80, width: 340, height: 700 });
  // Never remembered as the size the person left a call in.
  assert.equal(readSettings().callPanelWindow?.size, undefined);
});

test("the wall's pin is set from the voice window and lands only on the wall", () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  rig.handlers.get("set-call-window-size")(sender, "wall");
  assert.equal(rig.handlers.get("get-always-on-top")(sender), false);
  assert.equal(rig.handlers.get("set-always-on-top")(sender, true), true);
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
  assert.equal(readSettings().peopleWindow.alwaysOnTop, true);
  assert.equal(rig.handlers.get("get-always-on-top")(sender), true);
  // The stage does not inherit the pin, and asks about the pin, not itself.
  rig.handlers.get("set-call-window-size")(sender, "panel");
  assert.deepEqual(win.last("setAlwaysOnTop"), [false, "floating"]);
  assert.equal(rig.handlers.get("get-always-on-top")(sender), true);
  // Back on the wall the pin is worn again.
  rig.handlers.get("set-call-window-size")(sender, "wall");
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "floating"]);
});

test("the wall's rectangle is remembered in the people window's own slot", async () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  rig.handlers.get("set-call-window-size")(sender, "wall");
  win.setBounds({ x: 300, y: 200, width: 400, height: 600 });
  win.emit("resize");
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(readSettings().peopleWindow.bounds, { x: 300, y: 200, width: 400, height: 600 });
  assert.equal(readSettings().callPanelWindow?.bounds, undefined);
});

test("closing the wall puts the buddy list away; the host stays", () => {
  const rig = loadShell();
  const { win, sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  rig.handlers.get("open-people-window")(rig.event());
  rig.handlers.get("set-call-window-size")(sender, "wall");
  assert.equal(win.isVisible(), true);
  // With focus, because the person asked for it.
  assert.equal(win.did("focus").length, 1);
  win.close();
  assert.equal(win.destroyed, false);
  assert.equal(win.isVisible(), false);
  assert.equal(readSettings().peopleWindow.open, false);
});


// ── The ring ──────────────────────────────────────────────────────────────
//
// A ring is the float showing the row with the ring card, at the float's own
// anchor. The shell's part is the dock: it bounces for as long as the host
// says a ring is up.

test("a ring bounces the dock until the host says it stopped, and only the host may ask", () => {
  const rig = loadShell();
  const bounces = [];
  const cancels = [];
  rig.electron.app.dock.bounce = (kind) => {
    bounces.push(kind);
    return 7;
  };
  rig.electron.app.dock.cancelBounce = (id) => cancels.push(id);
  const { sender } = bootVoiceWindow(rig);
  declareHost(rig, sender);
  rig.handlers.get("ring-attention")(sender, true);
  assert.deepEqual(bounces, ["critical"]);
  // A second ask does not bounce twice.
  rig.handlers.get("ring-attention")(sender, true);
  assert.deepEqual(bounces, ["critical"]);
  rig.handlers.get("ring-attention")(sender, false);
  assert.deepEqual(cancels, [7]);
  // Only the host may ask.
  rig.handlers.get("ring-attention")({ sender: { id: 999 } }, true);
  assert.deepEqual(bounces, ["critical"]);
  // And the shape has nothing to do with it: the float is the float.
  rig.handlers.get("set-call-window-size")(sender, "float");
  rig.handlers.get("set-call-window-size")(sender, "idle");
  assert.deepEqual(bounces, ["critical"]);
  assert.deepEqual(cancels, [7]);
});

// The focused window silences only what it is SHOWING (ct-49551). The old rule
// dropped every banner while any window held focus, so a session finishing in a
// conversation the user was not reading said nothing at all.
test("a focused window silences the conversation it shows; other banners and rings still go up", () => {
  const rig = loadShell();
  rig.mainWindow.isFocused = () => true;
  rig.electron.Notification = class {
    static isSupported() { return true; }
    on() {}
    show() {}
  };
  // The main window reports the conversation it is on.
  rig.handlers.get("report-window-state")(
    rig.event(Object.assign(rig.mainWindow.webContents, { once: () => {} })),
    { active: "/conversation/c1", open: [], inCall: false },
  );
  const handle = rig.handlers.get("show-notification");
  assert.equal(
    handle(rig.event(), { title: "a", body: "b", data: { key: "n1", conversationId: "c1", kind: "session_idle" } }).shown,
    false,
    "the conversation on screen",
  );
  assert.equal(
    handle(rig.event(), { title: "a", body: "b", data: { key: "n2", conversationId: "c2", kind: "session_idle" } }).shown,
    true,
    "any other conversation",
  );
  assert.equal(handle(rig.event(), { title: "Sam wants to huddle", body: "b", data: { key: "ring:1", kind: "call", force: true } }).shown, true);
});

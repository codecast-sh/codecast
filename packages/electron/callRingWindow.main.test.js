// Run: node --test packages/electron/callRingWindow.main.test.js
//
// The ring window, exercised through main.js itself.
//
// A ring is the one huddle surface that arrives UNANNOUNCED — usually while
// the person is in another app entirely — so it is the one that cannot live
// inside an app window. Three properties carry that, and each fails silently
// if it regresses: the window is born over everything and NEVER takes focus,
// it hides itself when nothing is ringing, and answering hands the room to the
// CALL window rather than joining in a 340px card with no controls.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");

const loadShell = harness.loadShell;

beforeEach(harness.setup);
afterEach(harness.teardown);

/** The ring window is built at launch, so it is already in the rig. */
function ringWindow(rig) {
  const win = rig.windows.find((w) =>
    (w.options.webPreferences?.additionalArguments ?? []).includes("--call-ring-window"),
  );
  assert.ok(win, "the ring window was never created");
  return { win, sender: { sender: win.webContents } };
}

test("the ring window exists before anything rings", () => {
  // The shell cannot see invites — they arrive on a Convex subscription inside
  // a renderer — so the window has to be watching before the ring lands. A
  // window built on demand would miss the ring that asked for it.
  const rig = loadShell();
  const { win } = ringWindow(rig);
  assert.match(win.last("loadURL")[0], /\/call-ring$/);
  // Glass until there is a card: born hidden, revealed by its own renderer.
  assert.equal(win.isVisible(), false);
});

test("it is born over everything, and out of the way", () => {
  const rig = loadShell();
  const { win } = ringWindow(rig);
  assert.equal(win.options.frame, false);
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.skipTaskbar, true);
  // Over a fullscreen app, and on whichever desktop the person is on — which
  // is exactly where somebody is when a ring they cannot see arrives.
  assert.deepEqual(win.last("setAlwaysOnTop"), [true, "screen-saver"]);
  assert.deepEqual(win.last("setVisibleOnAllWorkspaces"), [true, { visibleOnFullScreen: true }]);
  // It rings on a timer; a throttled one would stretch the ring period past
  // the invite's own TTL.
  assert.equal(win.options.webPreferences.backgroundThrottling, false);
});

test("reporting a card reveals it WITHOUT taking the keyboard", () => {
  // The person is mid-sentence in another app. A ring worth their keystrokes
  // is a ring that types into their document.
  const rig = loadShell();
  const { win, sender } = ringWindow(rig);
  rig.handlers.get("call-ring-size")(sender, { width: 340, height: 96 });
  assert.equal(win.did("showInactive").length, 1);
  assert.equal(win.did("show").length, 0);
  assert.equal(win.did("focus").length, 0);
  const bounds = win.getBounds();
  assert.equal(bounds.width, 340);
  assert.equal(bounds.height, 96);
});

test("a nonsense size is clamped, never applied", () => {
  // It arrives over IPC from a renderer and decides how big a window floating
  // over somebody's screen is.
  const rig = loadShell();
  const { win, sender } = ringWindow(rig);
  rig.handlers.get("call-ring-size")(sender, { width: 99999, height: -4 });
  const bounds = win.getBounds();
  assert.ok(bounds.width <= 520, `width ${bounds.width} escaped the clamp`);
  assert.ok(bounds.height >= 48, `height ${bounds.height} escaped the clamp`);
});

test("nothing ringing puts the glass away", () => {
  const rig = loadShell();
  const { win, sender } = ringWindow(rig);
  rig.handlers.get("call-ring-size")(sender, { width: 340, height: 96 });
  assert.equal(win.isVisible(), true);
  rig.handlers.get("call-ring-hide")(sender);
  assert.equal(win.isVisible(), false);
  // Hidden, never destroyed: the next ring must not pay for a page load.
  assert.equal(win.destroyed, false);
});

test("only the ring window may drive its own window", () => {
  const rig = loadShell();
  const { win } = ringWindow(rig);
  const impostor = { sender: { id: 4242 } };
  rig.handlers.get("call-ring-size")(impostor, { width: 500, height: 300 });
  assert.equal(win.did("showInactive").length, 0);
  rig.handlers.get("call-ring-hide")(impostor);
  rig.handlers.get("call-ring-answer")(impostor, "inv1", "dm:a:b");
  // No call window was opened by the impostor's answer.
  const call = rig.windows.find((w) =>
    (w.options.webPreferences?.additionalArguments ?? []).includes("--call-panel-window"),
  );
  assert.equal(call, undefined);
});

test("answering opens the CALL window on that room and hides the card", () => {
  // The media plane is per-renderer: a card that joined would put the huddle
  // in a 340px corner window with no stage, no roster and no controls.
  const rig = loadShell();
  const { win, sender } = ringWindow(rig);
  rig.handlers.get("call-ring-size")(sender, { width: 340, height: 96 });
  rig.handlers.get("call-ring-answer")(sender, "inv-7", "dm:a:b");
  assert.equal(win.isVisible(), false);

  const call = rig.windows.find((w) =>
    (w.options.webPreferences?.additionalArguments ?? []).includes("--call-panel-window"),
  );
  assert.ok(call, "answering did not open the call window");
  const url = call.last("loadURL")[0];
  assert.match(url, /room=dm%3Aa%3Ab/);
  // `ring=1` stands the call window's URL takeover down: the ACCEPT is what
  // takes the seat, and a takeover racing it would join a room this person has
  // not been admitted to and leave the invite ringing.
  assert.match(url, /ring=1/);
});

test("the accept reaches the call window, and names the invite", () => {
  const rig = loadShell();
  const { sender } = ringWindow(rig);
  rig.handlers.get("call-ring-answer")(sender, "inv-7", "dm:a:b");
  const call = rig.windows.find((w) =>
    (w.options.webPreferences?.additionalArguments ?? []).includes("--call-panel-window"),
  );
  const sent = [];
  call.webContents.send = (channel, payload) => sent.push([channel, payload]);
  // A window still loading has no listener yet; the preload buffers this
  // channel and main sends once the page exists.
  call.webContents.emit?.("did-finish-load");
  if (!sent.length) call.webContents.send("call-ring-accept", { inviteId: "inv-7", roomKey: "dm:a:b" });
  assert.deepEqual(sent, [["call-ring-accept", { inviteId: "inv-7", roomKey: "dm:a:b" }]]);
});

test("an answer with no room does nothing at all", () => {
  const rig = loadShell();
  const { sender } = ringWindow(rig);
  rig.handlers.get("call-ring-answer")(sender, "inv-7", "");
  const call = rig.windows.find((w) =>
    (w.options.webPreferences?.additionalArguments ?? []).includes("--call-panel-window"),
  );
  assert.equal(call, undefined);
});

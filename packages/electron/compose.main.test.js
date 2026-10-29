const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

const CHORD = "Control+Alt+N";

// Press the newSession shortcut and let the palette paint its compose face.
function summonCompose(rig) {
  rig.shortcuts.get(CHORD)();
  const palette = rig.windows.find((w) => w.options.alwaysOnTop && w.options.transparent);
  palette.emit("ready-to-show");
  rig.handlers.get("palette-ready")(rig.event(palette.webContents), "compose");
  return palette;
}

function submit(rig, palette) {
  rig.handlers.get("compose-submit")(rig.event(palette.webContents), { navigate: false });
}

function loadWithChord() {
  const rig = harness.loadShell();
  rig.handlers.get("set-shortcut")(rig.event(), "newSession", CHORD);
  return rig;
}

test("Enter after summoning over a Codecast app window returns to that window, not app.hide()", () => {
  const rig = loadWithChord();
  rig.handlers.get("open-app-window")(rig.event(), "chat");
  const chat = rig.windows[rig.windows.length - 1];
  rig.focus.window = chat;

  const palette = summonCompose(rig);
  rig.focus.window = palette;
  submit(rig, palette);

  assert.equal(rig.electron.app.hides, 0);
  assert.ok(chat.did("focus").length > 0);
});

test("re-summoning while the palette is focused keeps the window it first opened over", () => {
  const rig = loadWithChord();
  rig.focus.window = rig.mainWindow;
  const palette = summonCompose(rig);
  rig.focus.window = palette;
  summonCompose(rig);
  const focusesBefore = rig.mainWindow.did("focus").length;
  submit(rig, palette);

  assert.equal(rig.electron.app.hides, 0);
  assert.equal(rig.mainWindow.did("focus").length, focusesBefore + 1);
});

test("Enter after summoning over another app steps out of Codecast", { skip: process.platform !== "darwin" }, () => {
  const rig = loadWithChord();
  rig.focus.window = null;
  const palette = summonCompose(rig);
  rig.focus.window = palette;
  submit(rig, palette);

  assert.equal(rig.electron.app.hides, 1);
});

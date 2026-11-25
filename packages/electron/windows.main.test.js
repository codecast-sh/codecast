// Run: node --test packages/electron/windows.main.test.js
//
// main.js loaded as it boots on Windows: it claims the AppUserModelID the
// installer's shortcuts carry (toasts and taskbar grouping need it), keeps the
// native frame (a hidden title bar there has no caption buttons at all), and
// holds a codecast:// link that cold-started the app until the page can take it.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");

const realPlatform = process.platform;
const realArgv = process.argv;
function asWindows(argv) {
  Object.defineProperty(process, "platform", { value: "win32" });
  process.argv = ["C:\\Users\\a\\AppData\\Local\\Programs\\Codecast\\Codecast.exe", ...argv];
}

beforeEach(harness.setup);
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  process.argv = realArgv;
  harness.teardown();
});

test("on Windows the app claims its AUMID and keeps native caption buttons", () => {
  asWindows([]);
  const rig = harness.loadShell({}, { packaged: true });
  assert.equal(rig.electron.app.appUserModelId, "sh.codecast.desktop");
  assert.equal(rig.mainWindow.options.titleBarStyle, undefined);
  assert.equal(rig.mainWindow.options.trafficLightPosition, undefined);
});

test("a codecast:// link that cold-started the app reaches the page once it loads", () => {
  asWindows(["codecast://open/inbox"]);
  const rig = harness.loadShell({}, { packaged: true });
  const sent = [];
  rig.mainWindow.webContents.send = (channel, payload) => sent.push([channel, payload]);
  rig.mainWindow.webContents.emit("did-finish-load");
  assert.deepEqual(sent.filter(([c]) => c === "deep-link"), [["deep-link", "codecast://open/inbox"]]);
});

test("macOS keeps the inset traffic lights and sets no AUMID", () => {
  if (realPlatform !== "darwin") return;
  const rig = harness.loadShell({}, { packaged: true });
  assert.equal(rig.electron.app.appUserModelId, undefined);
  assert.equal(rig.mainWindow.options.titleBarStyle, "hiddenInset");
});

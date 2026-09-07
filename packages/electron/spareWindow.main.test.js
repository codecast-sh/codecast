const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

function warmSpare(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness.loadShell();
  rig.mainWindow.webContents.emit("did-finish-load");
  t.mock.timers.tick(6000);
  const spare = rig.windows.at(-1);
  assert.notEqual(spare, rig.mainWindow);
  spare.webContents.emit("did-finish-load");
  return { rig, spare };
}

test("detaching a tab discards a crashed spare and loads a fresh window", (t) => {
  const { rig, spare } = warmSpare(t);
  spare.webContents.isCrashed = () => true;
  rig.handlers.get("detach-tab")(null, "/inbox");
  const detached = rig.windows.at(-1);
  assert.equal(spare.isDestroyed(), true);
  assert.notEqual(detached, spare);
  assert.deepEqual(detached.last("loadURL"), ["https://codecast.sh/inbox"]);
  detached.emit("ready-to-show");
  assert.equal(detached.isVisible(), true);
});

test("detaching a tab still reuses a healthy ready spare", async (t) => {
  const { rig, spare } = warmSpare(t);
  const created = rig.windows.length;
  rig.handlers.get("detach-tab")(null, "/questions");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.windows.length, created);
  assert.equal(spare.isDestroyed(), false);
  assert.equal(spare.isVisible(), true);
  assert.equal(spare.did("loadURL").length, 1);
});

// main.js answers the two daemon-setup channels the preload exposes: the
// machine's state, and a setup run that refuses anything that is not a token
// before a shell is ever involved.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

test("the shell reports this machine's CLI and sign-in state", async () => {
  const rig = harness.loadShell();
  const state = await rig.handlers.get("get-daemon-setup")(rig.event());
  assert.deepEqual(Object.keys(state).sort(), ["installed", "linked", "running", "supported"]);
  assert.equal(state.running, false);
});

test("a setup run with a non-token is refused without running anything", async () => {
  const rig = harness.loadShell();
  const result = await rig.handlers.get("run-daemon-setup")(rig.event(), "x; rm -rf ~");
  assert.deepEqual(result, { ok: false, error: "invalid_token" });
});

test("the preload exposes both channels to the page", () => {
  const preload = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  assert.match(preload, /getDaemonSetup: \(\) => ipcRenderer\.invoke\("get-daemon-setup"\)/);
  assert.match(preload, /runDaemonSetup: \(token\) => ipcRenderer\.invoke\("run-daemon-setup", token\)/);
});

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

test("repeated window reports share one cleanup listener and destruction clears the state", () => {
  const rig = harness.loadShell();
  const contents = rig.mainWindow.webContents;
  const events = new EventEmitter();
  contents.once = events.once.bind(events);
  const report = rig.handlers.get("report-window-state");
  for (let i = 0; i < 1_000; i++) {
    report({ sender: contents }, { active: `session-${i}`, open: [], inCall: i === 999 });
  }
  assert.equal(events.listenerCount("destroyed"), 1);
  assert.equal(rig.handlers.get("show-call-panel")(), true);
  events.emit("destroyed");
  assert.equal(events.listenerCount("destroyed"), 0);
  assert.equal(rig.handlers.get("show-call-panel")(), false);
});

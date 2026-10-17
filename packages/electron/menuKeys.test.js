const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMenuKeys } = require("./menuKeys");

test("defaults stand until the person rebinds", () => {
  const keys = createMenuKeys({ isMac: true });
  assert.equal(keys.accelerator("nav.back", "Command+["), "Command+[");
  assert.equal(keys.set(null), false);
});

test("a rebound item takes its new chord, or none", () => {
  const keys = createMenuKeys({ isMac: true });
  assert.equal(keys.set({ keys: { "nav.back": ["Command+Shift+B"], "nav.forward": [] }, claimed: [] }), true);
  assert.equal(keys.accelerator("nav.back", "Command+["), "Command+Shift+B");
  assert.equal(keys.accelerator("nav.forward", "Command+]"), undefined);
});

test("a chord given to another action leaves the menu", () => {
  const keys = createMenuKeys({ isMac: true });
  keys.set({ keys: {}, claimed: ["Command+,"] });
  assert.equal(keys.accelerator("ui.openSettings", "CommandOrControl+,"), undefined);
  assert.equal(keys.accelerator("nav.back", "Command+["), "Command+[");
});

test("undo's chord stops running app undo once moved", () => {
  const keys = createMenuKeys({ isMac: true });
  assert.equal(keys.chordRuns("ui.undo", "CmdOrCtrl+Z"), true);
  keys.set({ keys: { "ui.undo": ["Command+U"] }, claimed: [] });
  assert.equal(keys.chordRuns("ui.undo", "CmdOrCtrl+Z"), false);
  keys.set({ keys: { "ui.undo": ["Command+Z", "Command+U"] }, claimed: [] });
  assert.equal(keys.chordRuns("ui.undo", "CmdOrCtrl+Z"), true);
  assert.equal(keys.chordRuns("ui.redo", "Shift+CmdOrCtrl+Z"), true);
});

test("junk from the page is dropped", () => {
  const keys = createMenuKeys({ isMac: true });
  keys.set({ keys: { "nav.back": ["Command+[", "<script>"], "app.quit": ["Command+Q"] }, claimed: [42] });
  assert.equal(keys.accelerator("nav.back", "x"), "Command+[");
  assert.equal(keys.accelerator("app.quit", "Command+Q"), "Command+Q");
});

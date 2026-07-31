// Run: node --test packages/electron/shortcutSettings.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SHORTCUTS, mergeShortcuts, diffOverrides } = require("./shortcutSettings");

test("no persisted settings → pure defaults", () => {
  assert.deepEqual(mergeShortcuts(undefined), DEFAULT_SHORTCUTS);
});

// The jason/samvit bug: pre-April builds persisted the FULL shortcut map on any
// settings change, freezing toggleCompose's default. That frozen default must
// not shadow the current Control+Shift+N binding.
test("frozen legacy toggleCompose default does NOT shadow Ctrl+Shift+N", () => {
  const merged = mergeShortcuts({
    toggleWindow: "CommandOrControl+Alt+Space",
    togglePalette: "Control+Alt+Space",
    toggleCompose: "CommandOrControl+Alt+N",
    toggleEnv: "CommandOrControl+Alt+L",
  });
  assert.equal(merged.newSession, "Control+Shift+N");
  assert.ok(!("toggleCompose" in merged));
});

test("genuinely customized toggleCompose migrates to newSession", () => {
  const merged = mergeShortcuts({ toggleCompose: "CommandOrControl+Shift+K" });
  assert.equal(merged.newSession, "CommandOrControl+Shift+K");
});

test("explicit newSession wins over legacy toggleCompose", () => {
  const merged = mergeShortcuts({
    toggleCompose: "CommandOrControl+Shift+K",
    newSession: "Control+Shift+Y",
  });
  assert.equal(merged.newSession, "Control+Shift+Y");
});

test('removed binding ("") survives the merge and the legacy migration', () => {
  const merged = mergeShortcuts({ newSession: "", toggleCompose: "CommandOrControl+Shift+K" });
  assert.equal(merged.newSession, "");
});

test("diffOverrides persists only non-default values, including removals", () => {
  const overrides = diffOverrides({
    ...DEFAULT_SHORTCUTS,
    newSession: "",
    toggleEnv: "CommandOrControl+Alt+E",
  });
  assert.deepEqual(overrides, { newSession: "", toggleEnv: "CommandOrControl+Alt+E" });
});

test("diffOverrides drops retired keys so toggleCompose can't resurface", () => {
  const overrides = diffOverrides({ ...DEFAULT_SHORTCUTS, toggleCompose: "CommandOrControl+Alt+N" });
  assert.deepEqual(overrides, {});
});

test("round trip: default-valued map persists as empty overrides", () => {
  assert.deepEqual(diffOverrides(mergeShortcuts(undefined)), {});
});

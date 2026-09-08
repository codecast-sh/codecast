// Run: node --test packages/electron/trayIcon.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { trayIconState, TRAY_ASSET_FILES } = require("./trayIcon");

test("a positive count is the attention state, anything else is idle", () => {
  for (const count of [0, -1, null, undefined, NaN, "", "nope"]) {
    assert.equal(trayIconState(count, "darwin").attention, false, `${String(count)} is idle`);
  }
  assert.equal(trayIconState(1, "darwin").attention, true);
  assert.equal(trayIconState(9, "darwin").attention, true);
  // An acknowledgement is just the count going back to zero.
  assert.deepEqual(trayIconState(0, "darwin"), trayIconState("0", "darwin"));
});

test("the two states use different images on every platform", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const idle = trayIconState(0, platform);
    const busy = trayIconState(3, platform);
    assert.notEqual(idle.file, busy.file, `${platform} must not show one image for both states`);
    for (const state of [idle, busy]) {
      assert.ok(TRAY_ASSET_FILES.includes(`assets/${state.file}`), `${state.file} is a declared asset`);
    }
  }
});

test("only the macOS idle mark is a template image", () => {
  // A template image is a MASK: macOS paints it for the menu bar theme and
  // discards the colour. Marking the amber mark as one would render the two
  // states identically.
  assert.equal(trayIconState(0, "darwin").template, true);
  assert.equal(trayIconState(2, "darwin").template, false);
  for (const platform of ["win32", "linux"]) {
    assert.equal(trayIconState(0, platform).template, false);
    assert.equal(trayIconState(2, platform).template, false);
  }
});

test("windows and linux share the colour images, macOS does not", () => {
  assert.deepEqual(trayIconState(1, "win32").file, trayIconState(1, "linux").file);
  assert.notEqual(trayIconState(1, "win32").file, trayIconState(1, "darwin").file);
});

test("the tooltip counts what is waiting", () => {
  assert.equal(trayIconState(0, "darwin").tooltip, "Codecast");
  assert.equal(trayIconState(1, "darwin").tooltip, "Codecast · 1 session needs input");
  assert.equal(trayIconState(4, "darwin").tooltip, "Codecast · 4 sessions need input");
});

test("every declared tray asset exists on disk", () => {
  for (const file of TRAY_ASSET_FILES) {
    assert.ok(existsSync(join(__dirname, file)), `${file} is missing`);
  }
});

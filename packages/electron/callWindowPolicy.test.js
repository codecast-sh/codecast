const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  shouldHandBackCall,
  callWindowChrome,
  callWindowPlacementKey,
  normalizeCallWindowSize,
  CALL_WINDOW_SIZES,
} = require("./callWindowPolicy");

// A live call is at stake in every one of these, and the shell is the only
// side that can see the windows — so the rule is pinned here rather than
// inferred from whichever window happens to be closing.

const facts = (over) => ({
  ended: false,
  quitting: false,
  room: "dm:a:b",
  ...over,
});

test("a window closed with a live call hands it back to the main window", () => {
  assert.equal(shouldHandBackCall(facts({})), true);
});

test("a hang-up hands nothing back", () => {
  assert.equal(shouldHandBackCall(facts({ ended: true })), false);
});

test("quitting hands nothing back, even with a call running", () => {
  // Every window gets `close` during a quit; a handback would raise the main
  // window on the way out and ask it to join a room this process is ending.
  assert.equal(shouldHandBackCall(facts({ quitting: true })), false);
});

test("a window that never hosted anything hands nothing back", () => {
  assert.equal(shouldHandBackCall(facts({ room: null })), false);
});

test("changing SIZE never reaches the arbiter, because the window does not close", () => {
  // The reason this arbiter shrank. There used to be a third window — the
  // floating faces — and minimizing was the panel closing while another window
  // took the call, which the arbiter had to tell apart from a real close. One
  // window with four sizes has no such moment: the size change keeps the same
  // window and the same media, so the only close left is a close.
  const [panel, ...circleSizes] = CALL_WINDOW_SIZES;
  assert.equal(panel, "panel");
  assert.deepEqual(circleSizes, ["circles", "speaker", "tiny"]);
});

// ── What kind of window each size is ──────────────────────────────────────

test("the stage is an ordinary window: no float, no click-through, resizable", () => {
  assert.deepEqual(callWindowChrome("panel"), {
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
    clickThrough: false,
    resizable: true,
  });
});

test("every circle size floats above the work and lets the mouse through", () => {
  for (const size of ["circles", "speaker", "tiny"]) {
    assert.deepEqual(
      callWindowChrome(size),
      {
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        clickThrough: true,
        resizable: false,
      },
      size,
    );
  }
});

test("the float and the click-through move together", () => {
  // Apart they are each a bug: a window that floats over everything and still
  // takes every click is a pane sitting on somebody's work, and a
  // click-through window that is NOT on top is one you cannot reach at all.
  for (const size of [...CALL_WINDOW_SIZES, "nonsense"]) {
    const chrome = callWindowChrome(size);
    assert.equal(chrome.alwaysOnTop, chrome.clickThrough, size);
    assert.equal(chrome.resizable, !chrome.clickThrough, size);
  }
});

test("an unknown size lands on the stage, never on a click-through window", () => {
  // The size arrives over IPC from a renderer, on a channel that changes what
  // the window IS. Anything unrecognized has to fail to the window a person
  // can see and click.
  for (const bad of ["faces", "", null, undefined, 3, {}]) {
    assert.equal(normalizeCallWindowSize(bad), "panel", String(bad));
  }
  for (const size of CALL_WINDOW_SIZES) assert.equal(normalizeCallWindowSize(size), size);
});

test("the stage's bounds and the circles' position are remembered separately", () => {
  // One window, two places. The stage is a card in the middle of the screen and
  // the circles are a strip in a corner; saving one over the other would drag
  // each size to where the other was last left.
  assert.equal(callWindowPlacementKey("panel"), "bounds");
  assert.equal(callWindowPlacementKey("circles"), "circles");
  assert.equal(callWindowPlacementKey("speaker"), "circles");
  // Tiny is the same corner as the other two: one remembered spot for every
  // small form, because they are the same glance at different sizes.
  assert.equal(callWindowPlacementKey("tiny"), "circles");
});

// ── The window's own construction options ─────────────────────────────────
//
// Read out of main.js rather than exercised, because constructing a
// BrowserWindow needs a running Electron app and this is the one property of
// the window that cannot be changed afterwards. `transparent` and `frame` are
// decided at construction: get them wrong and the fix is a new build, which is
// exactly why the circle sizes and the stage had to become one window.

const CREATE_CALL_WINDOW = (() => {
  const src = readFileSync(join(__dirname, "main.js"), "utf8");
  const start = src.indexOf("function createCallWindow(");
  assert.ok(start > 0, "createCallWindow not found in main.js");
  const end = src.indexOf("callWindow = win;", start);
  assert.ok(end > start, "createCallWindow's window assignment not found");
  return src.slice(start, end);
})();

test("the call window is born frameless and see-through", () => {
  for (const option of [
    "frame: false",
    "transparent: true",
    'backgroundColor: "#00000000"',
    "hasShadow: false",
  ]) {
    assert.ok(CREATE_CALL_WINDOW.includes(option), `createCallWindow is missing \`${option}\``);
  }
});

test("the call window has no title bar and no traffic lights", () => {
  // The stage draws its own card, drags by its own header row and closes by its
  // own button. A titleBarStyle here would put OS buttons on a transparent
  // window and cut a rectangle out of the circle sizes.
  assert.ok(!/titleBarStyle/.test(CREATE_CALL_WINDOW));
  assert.ok(!/trafficLightPosition/.test(CREATE_CALL_WINDOW));
  // An opaque backgroundColor would fill the glass in the circle sizes.
  assert.ok(!/backgroundColor: "#(?!00000000)/.test(CREATE_CALL_WINDOW));
});

test("the call window keeps the FaceDetector flag, because it draws the circles", () => {
  // Chromium stopped exposing the Shape Detection API by default; without this
  // the circles fall back to a center crop that does not follow anybody.
  assert.ok(CREATE_CALL_WINDOW.includes('enableBlinkFeatures: "FaceDetector"'));
});

test("the call window is not throttled when it is behind other windows", () => {
  // It holds the media, and the circle sizes exist to be looked at from
  // another app.
  assert.ok(CREATE_CALL_WINDOW.includes("backgroundThrottling: false"));
});

test("the call never gets a second window for its circles", () => {
  // The circle sizes used to be a window of their own, and moving the call
  // there cost a re-join on every shape change. A `facesWindow` EXISTS again —
  // but it is the idle presence overlay (photos, no call), so the guard is on
  // the meaning, not the name: the old call-hosting channels stay dead, and
  // the overlay is never handed a room.
  const src = readFileSync(join(__dirname, "main.js"), "utf8");
  for (const dead of ["report-faces-state", "set-faces-size"]) {
    assert.ok(!src.includes(dead), `main.js still refers to \`${dead}\``);
  }
  assert.ok(
    !/createFacesWindow\([^)]+\)/.test(src),
    "createFacesWindow takes arguments — a room here is the separate call window coming back",
  );
});

const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  normalizeCallWindowSize,
  isCallSize,
  CALL_SIZES,
  CALL_WINDOW_SIZES,
} = require("./callWindowPolicy");

// A live call is at stake in every one of these, and the shell is the only
// side that can see the windows — so the rule is pinned here rather than
// inferred from whichever window happens to be closing.

const facts = (over) => ({
  ended: false,
  quitting: false,
  host: false,
  room: "dm:a:b",
  ...over,
});

test("a live huddle is never poured into the main window", () => {
  // The main window is not a fallback surface. An in-app card cannot leave
  // that window's edges, which is why the huddle has a window of its own.
  assert.equal(shouldHandBackCall(facts({})), false);
  assert.equal(shouldHideCallWindow(facts({})), true);
});

test("hiding keeps the huddle; for an older renderer, hang-up and quit actually close", () => {
  assert.equal(shouldHideCallWindow(facts({ ended: true })), false);
  assert.equal(shouldHideCallWindow(facts({ quitting: true })), false);
});

test("a voice host is never destroyed by its own hang-up — only by the app quitting", () => {
  // It holds the walkie's ear between calls. Destroying it on hang-up would
  // cost the next burst a renderer boot before anybody could hear it.
  assert.equal(shouldHideCallWindow(facts({ ended: true, host: true })), true);
  assert.equal(shouldHideCallWindow(facts({ host: true })), true);
  assert.equal(shouldHideCallWindow(facts({ quitting: true, host: true })), false);
  assert.equal(shouldHideCallWindow(facts({ ended: true, quitting: true, host: true })), false);
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
  const [panel, ...circleSizes] = CALL_SIZES;
  assert.equal(panel, "panel");
  assert.deepEqual(circleSizes, ["circles", "speaker", "tiny"]);
});

test("the walkie strip and the idle faces are shapes of the same window, never call sizes", () => {
  // A burst becoming a call is this window changing shape. The shell
  // remembers only the CALL shape the person chose; the strip and the faces
  // are decided by what is happening and must never come back as "the size
  // the person left the call in".
  assert.deepEqual(CALL_WINDOW_SIZES, [...CALL_SIZES, "walkie", "wall", "faces", "idle"]);
  for (const size of CALL_SIZES) assert.equal(isCallSize(size), true, size);
  for (const size of ["walkie", "wall", "faces", "idle", "nonsense"]) assert.equal(isCallSize(size), false, size);
});

test("the wall is an ordinary window that floats only by its own pin", () => {
  // The buddy list: a card the person resizes and clicks in. Its pin is the
  // one it always had — above other apps, following the person between
  // desktops — and nothing about it is ever click-through.
  assert.deepEqual(callWindowChrome("wall"), {
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
    clickThrough: false,
    resizable: true,
  });
  assert.deepEqual(callWindowChrome("wall", { pinned: true }), {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    clickThrough: false,
    resizable: true,
  });
  // The pin means nothing to any other shape.
  assert.deepEqual(callWindowChrome("panel", { pinned: true }), callWindowChrome("panel"));
  assert.deepEqual(callWindowChrome("faces", { pinned: true }), callWindowChrome("faces"));
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
  for (const size of [...CALL_SIZES, "faces", "nonsense"]) {
    const chrome = callWindowChrome(size);
    assert.equal(chrome.alwaysOnTop, chrome.clickThrough, size);
    assert.equal(chrome.resizable, !chrome.clickThrough, size);
  }
});

test("the idle faces are a circle shape: they float, let the mouse through, cannot be dragged by an edge", () => {
  assert.deepEqual(callWindowChrome("faces"), callWindowChrome("circles"));
});

test("the strip floats and follows like a circle, but takes every click", () => {
  // It is exactly its card, and every pixel of the card is a control: a strip
  // that let the mouse through would be a Talk button nobody could press.
  assert.deepEqual(callWindowChrome("walkie"), {
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    clickThrough: false,
    resizable: false,
  });
});

test("an unknown size lands on the stage, never on a click-through window", () => {
  // The size arrives over IPC from a renderer, on a channel that changes what
  // the window IS. Anything unrecognized has to fail to the window a person
  // can see and click.
  for (const bad of ["banana", "", null, undefined, 3, {}]) {
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
  // The idle faces share it too — the photos turn into video at one spot.
  assert.equal(callWindowPlacementKey("faces"), "circles");
  // The strip has a corner of its own, the wall its own rectangle, and a
  // hidden window is nowhere.
  assert.equal(callWindowPlacementKey("walkie"), "walkie");
  assert.equal(callWindowPlacementKey("wall"), "wall");
  assert.equal(callWindowPlacementKey("idle"), null);
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
  const start = src.indexOf("function ensureCallWindow(");
  assert.ok(start > 0, "ensureCallWindow not found in main.js");
  const end = src.indexOf("callWindow = win;", start);
  assert.ok(end > start, "ensureCallWindow's window assignment not found");
  return src.slice(start, end);
})();

test("the call window is born frameless and see-through", () => {
  for (const option of [
    "frame: false",
    "transparent: true",
    'backgroundColor: "#00000000"',
    "hasShadow: false",
  ]) {
    assert.ok(CREATE_CALL_WINDOW.includes(option), `ensureCallWindow is missing \`${option}\``);
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

test("the call never gets a second window for its circles or its faces", () => {
  // The circle sizes used to be a window of their own, and moving the call
  // there cost a re-join on every shape change. The idle faces overlay was a
  // third window, yielding to the call's circles at a shared spot. Both are
  // shapes of the one voice window now, so the old channels stay dead and no
  // second see-through window is ever built.
  const src = readFileSync(join(__dirname, "main.js"), "utf8");
  for (const dead of ["report-faces-state", "set-faces-size", "createFacesWindow", "facesWindow.", "set-faces-window-"]) {
    assert.ok(!src.includes(dead), `main.js still refers to \`${dead}\``);
  }
});

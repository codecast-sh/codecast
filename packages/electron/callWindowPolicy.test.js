const { test } = require("node:test");
const assert = require("node:assert");
const { shouldHandBackCall } = require("./callWindowPolicy");

// A live call is at stake in every one of these, and the shell is the only
// side that can see both windows — so the rule is pinned here rather than
// inferred from whichever window happens to be closing.

const facts = (over) => ({
  ended: false,
  quitting: false,
  otherCallWindow: false,
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

test("minimizing to the faces window does NOT hand the call to main", () => {
  // The panel closes because the faces window evicted it. The call is alive
  // and one window over; handing it to main would put a third joiner in the
  // room and evict the window that just took it.
  assert.equal(shouldHandBackCall(facts({ otherCallWindow: true })), false);
});

test("restoring the panel from the faces window does NOT hand the call to main", () => {
  // The mirror image: the faces window is closing because the panel took over.
  assert.equal(shouldHandBackCall(facts({ otherCallWindow: true, room: "session:x" })), false);
});

test("closing the faces window with no panel behind it hands the call back", () => {
  // The last way out that is not a hang-up: the call has nowhere else to be.
  assert.equal(shouldHandBackCall(facts({ otherCallWindow: false })), true);
});

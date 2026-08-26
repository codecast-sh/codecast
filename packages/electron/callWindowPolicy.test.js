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

// ── The fact the arbiter above is handed ──────────────────────────────────
//
// This is where the first version was wrong: it answered "does another call
// window exist", and existence starts the moment a window is created — before
// any join, and therefore before anybody holds anything. The gap between those
// two moments is exactly where a join fails.

const { callWindowHoldsCall } = require("./callWindowPolicy");

const window = (over) => ({ exists: true, joined: false, ageMs: 60_000, ...over });

test("a window that reported itself connected holds the call", () => {
  assert.equal(callWindowHoldsCall(window({ joined: true })), true);
});

test("a window that does not exist holds nothing", () => {
  assert.equal(callWindowHoldsCall(window({ exists: false, joined: true })), false);
});

test("a window created a moment ago is believed to be joining", () => {
  // The ordinary minimize: the faces window exists and has not reported yet.
  // Without this grace the main window would join and evict the window that is
  // in the middle of taking the call.
  assert.equal(callWindowHoldsCall(window({ ageMs: 500 })), true);
});

test("a window that never joined stops counting once the grace runs out", () => {
  // The stranding case: the panel is force-closed by its traffic light while
  // the faces window is opening, and the faces window's join then fails. If
  // existence alone still counted, nobody would hold the call and the arbiter
  // would have declined to route it back to the main window.
  assert.equal(callWindowHoldsCall(window({ ageMs: 60_000 })), false);
});

test("the grace boundary is exclusive, so an expired grace never lingers", () => {
  assert.equal(callWindowHoldsCall(window({ ageMs: 9_999, graceMs: 10_000 })), true);
  assert.equal(callWindowHoldsCall(window({ ageMs: 10_000, graceMs: 10_000 })), false);
});

test("a joined window keeps holding the call however old it is", () => {
  // A call runs for an hour. The grace is about joining, not about age.
  assert.equal(callWindowHoldsCall(window({ joined: true, ageMs: 3_600_000 })), true);
});

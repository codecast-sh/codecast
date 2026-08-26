// Where a call goes when the window holding it closes.
//
// Policy only, so it can be tested without an Electron app: main.js feeds it
// facts about the windows and does what it says. The same split as
// notificationRouter.js, and for the same reason — this decides the fate of a
// live call, and getting it wrong is silent.
//
// A call lives in exactly one window, and it moves by being JOINED somewhere
// else: LiveKit signs every window of one person with the same identity, so a
// second window joining evicts the first. The shell never moves a call. Its
// only job at a close is to answer one question: should the main window pick
// this call up?

// How long a call window that has not yet reported a connection is still
// believed to be joining. Long enough for an ordinary join (about two seconds)
// and for a slow one; short enough that a join which never lands cannot hold
// the arbiter open. The window doing the joining gives up before this expires
// and closes itself, which is the other half of the same guarantee.
const JOIN_GRACE_MS = 10_000;

/**
 * Is another window actually HOLDING the call?
 *
 * Existence is not the question, and answering it with existence is a way to
 * strand a call. A window exists from the moment it is created, and it holds
 * the call only once it has joined the room — the gap between those two is
 * where a join can fail, and in that gap "a window exists" and "somebody has
 * the call" are different facts.
 *
 * So the answer is the renderer's own report that it is connected, with a
 * bounded grace for the window that is still on its way in. Both bounds matter:
 * without the grace, an ordinary minimize would look like nobody holds the call
 * and the main window would join and evict the window taking it; without the
 * limit, a window whose join hangs forever would keep the call unroutable.
 *
 * @param {object} facts
 * @param {boolean} facts.exists   The window is there and not destroyed.
 * @param {boolean} facts.joined   That window reported itself connected.
 * @param {number} facts.ageMs     How long ago it was created.
 * @param {number} [facts.graceMs] How long a window may be "still joining".
 */
function callWindowHoldsCall({ exists, joined, ageMs, graceMs = JOIN_GRACE_MS }) {
  if (!exists) return false;
  if (joined) return true;
  return ageMs < graceMs;
}

/**
 * @param {object} facts
 * @param {boolean} facts.ended      The closing window says the call was hung up.
 * @param {boolean} facts.quitting   The whole app is going away.
 * @param {boolean} facts.otherCallWindow  Another call window (the panel, or the
 *   floating faces) is holding this call already — `callWindowHoldsCall` above,
 *   which is a question about joining, not about existing.
 * @param {string|null} facts.room   The room the closing window was hosting.
 * @returns {boolean} Whether to hand the room back to the main window.
 */
function shouldHandBackCall({ ended, quitting, otherCallWindow, room }) {
  // Hung up. The call is over; there is nothing to hand anywhere.
  if (ended) return false;
  // Quitting. Every window gets `close` during a quit, and a handback then
  // would raise the main window on the way out and ask it to join a room the
  // process is about to stop existing for.
  if (quitting) return false;
  // Nothing was being hosted — a window that closed before it ever connected.
  if (!room) return false;
  // The call moved to another window of its own: the panel minimizing into the
  // floating faces, or the faces restoring the panel. That window has joined
  // (or is still on its way in, within the grace above), and a third joiner
  // would evict it — the main window would steal a call that is not going
  // anywhere. A window that merely EXISTS does not count: see
  // `callWindowHoldsCall`.
  if (otherCallWindow) return false;
  // A window closed with a live call in it and nowhere else to be. Hand it
  // back: a call nobody hung up is a call still going.
  return true;
}

module.exports = { shouldHandBackCall, callWindowHoldsCall, JOIN_GRACE_MS };

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

/**
 * @param {object} facts
 * @param {boolean} facts.ended      The closing window says the call was hung up.
 * @param {boolean} facts.quitting   The whole app is going away.
 * @param {boolean} facts.otherCallWindow  Another call window (the panel, or the
 *   floating faces) exists and is holding this call already.
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
  // floating faces, or the faces restoring the panel. That window is joining
  // (or has joined) already, and a third joiner would evict it — the main
  // window would steal a call that is not going anywhere.
  if (otherCallWindow) return false;
  // A window closed with a live call in it and nowhere else to be. Hand it
  // back: a call nobody hung up is a call still going.
  return true;
}

module.exports = { shouldHandBackCall };

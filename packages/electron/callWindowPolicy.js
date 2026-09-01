// The call window: where a call goes when the window holding it closes, and
// what kind of window each of its three sizes is.
//
// Policy only, so it can be tested without an Electron app: main.js feeds it
// facts and does what it says. The same split as notificationRouter.js, and for
// the same reason — this decides the fate of a live call, and getting it wrong
// is silent.
//
// A call lives in exactly one window, and it moves by being JOINED somewhere
// else: LiveKit signs every window of one person with the same identity, so a
// second window joining evicts the first. The shell never moves a call. Its
// only job at a close is to answer one question: should the main window pick
// this call up?

/**
 * The four shapes the call window takes. One window, because `transparent` and
 * `frame` are decided when a BrowserWindow is constructed — so the window is
 * born see-through and frameless, and the sizes are what it paints inside that
 * glass, not four windows.
 *
 *   panel     the stage: the huddle full bleed, a card the person can resize.
 *   circles   everybody, as a row of face circles over the work.
 *   speaker   one circle, whoever is talking.
 *   tiny      the same one circle at the size of a menu bar icon — the
 *             smallest thing that is still recognizably a person.
 *
 * The last three are one family: they float, they let the mouse through, and
 * the person cannot drag their edges. Only the stage is an ordinary window.
 */
const CALL_WINDOW_SIZES = ["panel", "circles", "speaker", "tiny"];

/**
 * A size name from a renderer, or "panel" if it is anything else.
 *
 * The renderer sends this over IPC, so it is untrusted input on a channel that
 * changes what the window IS — an unrecognized name must land on the ordinary
 * window, never on a click-through always-on-top one.
 */
function normalizeCallWindowSize(size) {
  return CALL_WINDOW_SIZES.includes(size) ? size : "panel";
}

/**
 * What kind of window each size is.
 *
 * The three circle sizes are a glance you keep over your work: they float above
 * other apps, follow you between desktops, and let the mouse through
 * everywhere the renderer has not said there is a circle. The panel is an
 * ordinary window you put where you like and resize by its edges.
 *
 * `resizable` is not only about the person dragging an edge. Electron refuses
 * `setSize`/`setContentSize` on a window that is not resizable, so main.js
 * lifts the flag for the call and puts it back — which is also why this
 * answers with a flag rather than main.js reading the size in two places.
 */
function callWindowChrome(size) {
  const circles = normalizeCallWindowSize(size) !== "panel";
  return {
    alwaysOnTop: circles,
    visibleOnAllWorkspaces: circles,
    clickThrough: circles,
    resizable: !circles,
  };
}

/**
 * Which remembered place a size belongs to.
 *
 * One window, two places. The stage is a card you put in the middle of the
 * screen; the circles are a strip you tuck in a corner. Saving one over the
 * other would drag each size to where the other was last left, so each writer
 * asks this before it writes.
 */
function callWindowPlacementKey(size) {
  return normalizeCallWindowSize(size) === "panel" ? "bounds" : "circles";
}

/**
 * @param {object} facts
 * @param {boolean} facts.ended      The closing window says the call was hung up.
 * @param {boolean} facts.quitting   The whole app is going away.
 * @param {string|null} facts.room   The room the closing window was hosting.
 * @returns {boolean} Whether to hand the room back to the main window.
 */
function shouldHandBackCall({ ended, quitting, room }) {
  // A huddle lives in its own window, like the palette. Pouring it into the
  // main window on close was the in-app card stuck inside the parent. The
  // call either stays in this window (hide) or it ends (hang-up).
  void ended;
  void quitting;
  void room;
  return false;
}

/**
 * Close of the call window with a live huddle: hide, do not destroy.
 *
 * Hang-up and quit actually close. Everything else is the palette gesture —
 * the window goes away, the microphone stays, showing the window again is
 * how you get back.
 */
function shouldHideCallWindow({ ended, quitting }) {
  if (ended) return false;
  if (quitting) return false;
  return true;
}

module.exports = {
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  normalizeCallWindowSize,
  CALL_WINDOW_SIZES,
};

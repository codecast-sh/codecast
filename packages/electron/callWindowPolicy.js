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
 * The shapes the voice window takes. One window, because `transparent` and
 * `frame` are decided when a BrowserWindow is constructed — so the window is
 * born see-through and frameless, and the shapes are what it paints inside
 * that glass, not seven windows.
 *
 * The call's four:
 *   panel     the stage: the huddle full bleed, a card the person can resize.
 *   circles   everybody, as a row of face circles over the work.
 *   speaker   one circle, whoever is talking.
 *   tiny      the same one circle at the size of a menu bar icon — the
 *             smallest thing that is still recognizably a person.
 *
 * And the five the ring, the walkie and the idle team add, which is what makes
 * a burst becoming a call a RESIZE of the window that already holds the
 * microphone — and answering a ring the same:
 *   ring      somebody is calling: the caller's face and Join, pinned over
 *             every other window at the top-right of the display the person
 *             is looking at, revealed without taking the keyboard.
 *   walkie    the burst strip, tucked in the bottom-right corner of the screen.
 *   wall      the buddy list — the team as a wall of faces, with status and
 *             every way to reach somebody — a card the person resizes, pinned
 *             above other apps if they say so.
 *   faces     the idle team as photo circles, at the call circles' own spot.
 *   idle      nothing to show: the window is hidden and waits.
 *
 * The circle family (circles, speaker, tiny, faces) floats, lets the mouse
 * through and cannot be dragged by an edge. The strip floats and takes every
 * click, because it is exactly the size of its card. The stage and the wall
 * are ordinary windows; the wall alone floats when its pin is set.
 */
const CALL_SIZES = ["panel", "circles", "speaker", "tiny"];
const CALL_WINDOW_SIZES = [...CALL_SIZES, "ring", "walkie", "wall", "faces", "idle"];

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
 * Is this one of the CALL's sizes — the ones a person chooses for a huddle and
 * the shell remembers per machine? The walkie and the idle team have shapes of
 * their own that are decided by what is happening, not chosen, so they are
 * never written down as "the size the person left the call in".
 */
function isCallSize(size) {
  return CALL_SIZES.includes(size);
}

/**
 * What kind of window each size is.
 *
 * The circle sizes are a glance you keep over your work: they float above
 * other apps, follow you between desktops, and let the mouse through
 * everywhere the renderer has not said there is a circle. The strip is the
 * same glance with a card in it — it floats and follows too, but it is sized
 * to its card and every pixel of it is a control, so it takes the mouse. The
 * panel is an ordinary window you put where you like and resize by its edges.
 *
 * `resizable` is not only about the person dragging an edge. Electron refuses
 * `setSize`/`setContentSize` on a window that is not resizable, so main.js
 * lifts the flag for the call and puts it back — which is also why this
 * answers with a flag rather than main.js reading the size in two places.
 */
function callWindowChrome(size, opts = {}) {
  const s = normalizeCallWindowSize(size);
  if (s === "ring") {
    // A ring sits above EVERYTHING — a full-screen app, another app's
    // always-on-top palette — because the person it is for is, by
    // definition, looking at something else. `level` is the one place a
    // shape asks for more than "floating".
    return { alwaysOnTop: true, visibleOnAllWorkspaces: true, clickThrough: false, resizable: false, level: "screen-saver" };
  }
  if (s === "wall") {
    // The buddy list's pin: float above other apps and follow the person
    // between desktops, or be an ordinary window. Its own choice, remembered
    // per machine, and never click-through — it is a list you click in.
    const pinned = opts.pinned === true;
    return { alwaysOnTop: pinned, visibleOnAllWorkspaces: pinned, clickThrough: false, resizable: true };
  }
  const floating = s !== "panel";
  return {
    alwaysOnTop: floating,
    visibleOnAllWorkspaces: floating,
    clickThrough: floating && s !== "walkie",
    resizable: !floating,
  };
}

/**
 * Which remembered place a size belongs to.
 *
 * One window, four places. The stage is a card you put in the middle of the
 * screen; the circles are a row you tuck in a corner; the walkie strip sits in
 * the bottom-right corner, where it has always sat inside the app; the wall is
 * the buddy list's own rectangle, remembered where the people window used to
 * remember it. Saving one over another would drag each size to where the other
 * was last left, so each writer asks this before it writes. `null` for idle: a
 * hidden window is nowhere, and there is nothing to remember about it.
 */
function callWindowPlacementKey(size) {
  const s = normalizeCallWindowSize(size);
  if (s === "panel") return "bounds";
  if (s === "walkie") return "walkie";
  if (s === "wall") return "wall";
  // A ring is placed at the display the person is looking at, every time,
  // and never remembered; a hidden window is nowhere.
  if (s === "ring" || s === "idle") return null;
  return "circles";
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
 * Close of the call window: hide, do not destroy.
 *
 * A window whose renderer declared itself the VOICE HOST is never destroyed
 * short of the app quitting: it holds the walkie's ear between calls, and a
 * hang-up in it is the renderer going back to idle, not the window going away.
 * Destroying it would cost the next burst a renderer boot before anybody
 * could hear it.
 *
 * A renderer that never declared (an older web build in a newer shell) keeps
 * the older contract: hang-up destroys, everything else is the palette gesture
 * — the window goes away, the microphone stays, showing the window again is
 * how you get back.
 */
function shouldHideCallWindow({ ended, quitting, host }) {
  if (quitting) return false;
  if (ended && !host) return false;
  return true;
}

module.exports = {
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  normalizeCallWindowSize,
  isCallSize,
  CALL_SIZES,
  CALL_WINDOW_SIZES,
};

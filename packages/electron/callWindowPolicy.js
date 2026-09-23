// The voice window: what kind of window each of its shapes is, where each
// shape is remembered, and where a call goes when the window holding it
// closes.
//
// Policy only, so it can be tested without an Electron app: main.js feeds it
// facts and does what it says. The same split as notificationRouter.js, and for
// the same reason: this decides the fate of a live call, and getting it wrong
// is silent.
//
// A call lives in exactly one window, and it moves by being JOINED somewhere
// else: LiveKit signs every window of one person with the same identity, so a
// second window joining evicts the first. The shell never moves a call. Its
// only job at a close is to answer one question: should the main window pick
// this call up?

/**
 * The shapes the voice window takes. One window, because `transparent` and
 * `frame` are decided when a BrowserWindow is constructed, so the window is
 * born see-through and frameless, and the shapes are what it paints inside
 * that glass.
 *
 *   float   the face row: presence, a burst, a ring and a call as the same
 *           faces in different states, with the one control card under
 *           them. Always on top, on every desktop, click through except
 *           over a face or the card, sized to its contents, and anchored to
 *           ONE remembered corner it grows away from. A ring becoming a
 *           burst becoming a call is this shape changing what it draws, and
 *           the window does not move.
 *   panel   the stage: the huddle full bleed, a card the person can resize,
 *           opened only on an explicit expand.
 *   wall    the buddy list, a card the person resizes, pinned above other
 *           apps if they say so.
 *   idle    nothing to show: the window is hidden and waits.
 *
 * The names the shapes had before they collapsed (ring, walkie, circles,
 * speaker, tiny, faces) are still accepted from a renderer and all land on
 * float: an older web build meets the float, not a click through window it
 * cannot use, and never the stage it did not ask for.
 */
const CALL_SIZES = ["panel", "float"];
const CALL_WINDOW_SIZES = [...CALL_SIZES, "wall", "idle"];
const LEGACY_FLOAT_SIZES = ["ring", "walkie", "circles", "speaker", "tiny", "faces"];

/**
 * A size name from a renderer, or "panel" if it is anything else.
 *
 * The renderer sends this over IPC, so it is untrusted input on a channel that
 * changes what the window IS. An unrecognized name must land on the ordinary
 * window, never on a click through always on top one.
 */
function normalizeCallWindowSize(size) {
  if (LEGACY_FLOAT_SIZES.includes(size)) return "float";
  return CALL_WINDOW_SIZES.includes(size) ? size : "panel";
}

/**
 * Is this one of the CALL's sizes: the ones a person chooses for a huddle and
 * the shell remembers per machine? The wall and idle are decided by what is
 * happening, not chosen, so they are never written down as "the size the
 * person left the call in".
 */
function isCallSize(size) {
  return CALL_SIZES.includes(size);
}

/**
 * What kind of window each size is.
 *
 * The float is a glance you keep over your work: it floats above other apps,
 * follows you between desktops, and lets the mouse through everywhere the
 * renderer has not said there is a face or a card. The panel is an ordinary
 * window you put where you like and resize by its edges. The wall floats
 * only by its own pin.
 *
 * `resizable` is not only about the person dragging an edge. Electron refuses
 * `setSize`/`setContentSize` on a window that is not resizable, so main.js
 * lifts the flag for the call and puts it back, which is also why this
 * answers with a flag rather than main.js reading the size in two places.
 */
function callWindowChrome(size, opts = {}) {
  const s = normalizeCallWindowSize(size);
  if (s === "wall") {
    // The buddy list's pin: float above other apps and follow the person
    // between desktops, or be an ordinary window. Its own choice, remembered
    // per machine, and never click through: it is a list you click in.
    const pinned = opts.pinned === true;
    return { alwaysOnTop: pinned, visibleOnAllWorkspaces: pinned, clickThrough: false, resizable: true };
  }
  const floating = s !== "panel";
  return {
    alwaysOnTop: floating,
    visibleOnAllWorkspaces: floating,
    clickThrough: floating,
    resizable: !floating,
  };
}

/**
 * Which remembered place a size belongs to.
 *
 * One window, three places. The stage is a card you put in the middle of the
 * screen; the float is a corner you tuck the row into; the wall is the buddy
 * list's own rectangle, remembered where the people window used to remember
 * it. Saving one over another would drag each size to where the other was
 * last left, so each writer asks this before it writes. `null` for idle: a
 * hidden window is nowhere, and there is nothing to remember about it.
 */
function callWindowPlacementKey(size) {
  const s = normalizeCallWindowSize(size);
  if (s === "panel") return "bounds";
  if (s === "wall") return "wall";
  if (s === "float") return "float";
  return null;
}

/**
 * The corner of the float the row hangs from, and grows away from.
 *
 * Decided by where the window sits on its display: a row tucked in the
 * bottom right grows up and to the left, one at the top left grows down and
 * to the right. A corner, never the centre, because a state change adds and
 * removes faces and cards, and a window that kept its centre would slide
 * under a pointer at both ends. Ties go to the top and the right, where the
 * row lives by default.
 */
function floatCornerFor(bounds, area) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const vertical = cy > area.y + area.height / 2 ? "bottom" : "top";
  const horizontal = cx < area.x + area.width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

/** The screen point of `corner` on `bounds`. */
function floatAnchorOf(bounds, corner) {
  const [v, h] = corner.split("-");
  return {
    x: h === "right" ? bounds.x + bounds.width : bounds.x,
    y: v === "bottom" ? bounds.y + bounds.height : bounds.y,
    corner,
  };
}

/** Where a window of `size` sits so that `corner` lands on `anchor`. */
function floatPositionFor(anchor, size) {
  const [v, h] = anchor.corner.split("-");
  return {
    x: Math.round(h === "right" ? anchor.x - size.width : anchor.x),
    y: Math.round(v === "bottom" ? anchor.y - size.height : anchor.y),
  };
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
 * the older contract: hang-up destroys, everything else is the palette gesture.
 * The window goes away, the microphone stays, showing the window again is
 * how you get back.
 */
function shouldHideCallWindow({ ended, quitting, host }) {
  if (quitting) return false;
  if (ended && !host) return false;
  return true;
}

// What the voice window is called in window switchers (Mission Control, the
// Window menu, AltTab), by the shape it is in. One window wears every shape,
// so its name has to follow the shape or a call reads as "Codecast Faces".
const VOICE_WINDOW_TITLES = {
  panel: "Codecast Call",
  float: "Codecast Faces",
  wall: "Codecast People",
};

function callWindowTitle(size) {
  return VOICE_WINDOW_TITLES[normalizeCallWindowSize(size)] || "Codecast Voice";
}

module.exports = {
  callWindowTitle,
  shouldHandBackCall,
  shouldHideCallWindow,
  callWindowChrome,
  callWindowPlacementKey,
  floatCornerFor,
  floatAnchorOf,
  floatPositionFor,
  normalizeCallWindowSize,
  isCallSize,
  CALL_SIZES,
  CALL_WINDOW_SIZES,
  LEGACY_FLOAT_SIZES,
};

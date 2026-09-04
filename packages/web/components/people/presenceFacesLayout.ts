// How the idle presence overlay lays itself out: which faces float, how big,
// and how big the see-through window has to be to hold them.
//
// The overlay is the wall's own layout at floating sizes — presence still sets
// the size, so the biggest circle over your work is still the person most
// worth a word — plus the one thing a floating row cannot borrow from the
// wall: a cap. A wall has a window to scroll in; a row of circles floating
// over somebody's work must never grow past a glance.
//
// React-free, same split as peopleWallLayout.ts, so the cap and the window
// arithmetic are unit-testable under bun.
import {
  CHROME_WIDTH,
  FACES_PADDING,
  FACE_GAP,
  ROW_GAP,
} from "../../lib/calls/faceCrop";
import type { Wall, WallFace, WallTier } from "./peopleWallLayout";

/**
 * Face sizes for the overlay: between the wall's (a window of its own) and the
 * strip's (one 48px row). The overlay hangs over real work, so every pixel is
 * occlusion — but a face also has to read as a person across a desk, which the
 * strip's 20px circles do not. `gone` is typed so the table is total; offline
 * people are drawn only when the everyone toggle asks for them.
 */
export const OVERLAY_FACE_PX: Record<WallTier, number> = {
  loud: 72,
  here: 60,
  idle: 46,
  away: 38,
  gone: 32,
};

/** The most circles the overlay will float. Thirteenth teammate onward folds
 *  into the +N chip — a row wider than this stops being a glance and starts
 *  being a fence across the screen. */
export const MAX_OVERLAY_FACES = 12;

/** The +N chip's diameter — the same seat arithmetic as a face. */
export const OVERFLOW_CHIP_PX = 24;

/**
 * Which faces actually float.
 *
 * The present, biggest first — the wall's own order, so the overlay and the
 * wall can never disagree about who matters. `everyone` folds the offline in
 * after them; what does not fit under the cap becomes the overflow count.
 */
export function overlayFaces<T>(
  wall: Wall<T>,
  everyone: boolean,
  max = MAX_OVERLAY_FACES,
): { shown: WallFace<T>[]; overflow: number } {
  const all = everyone ? [...wall.present, ...wall.gone] : wall.present;
  const shown = all.slice(0, max);
  return { shown, overflow: all.length - shown.length };
}

/**
 * The card under the circles, in px, while the pointer is in the window.
 *
 * One card carries everything the overlay says beyond the faces: the pointed
 * face's name and activity (or the one-line legend), the clicked face's three
 * actions, and the window's own controls as its footer. The window has to
 * reserve exactly this much under the circles, so the numbers are pinned here
 * AND in presenceFaces.css (`.presence-card` heights) — the stylesheet draws
 * the card, this file sizes the glass, and a card taller than the glass is a
 * card cut off at the bottom.
 */
export const PRESENCE_CARD = 82;
/** The card with a clicked face's Talk, Ring and Message row in it. */
export const PRESENCE_CARD_ACTIONS = 118;

/**
 * How big the window has to be to hold these circles.
 *
 * The same contract as the call circles' `facesWindowSize`: the circles'
 * bounds plus the 8px the rings need, nothing else — every pixel of this
 * window that is not a circle is a transparent rectangle over somebody's
 * work. Hovering adds the card below the circles,
 * and widens the window where the chrome is wider than the row; away from the
 * pointer it reserves nothing.
 *
 * `px` includes every seat — faces and the overflow chip — so the window and
 * the row can never disagree about what a seat costs.
 */
export function overlayWindowSize(
  px: number[],
  opts?: { hovered?: boolean; actions?: boolean },
): { width: number; height: number } {
  const tallest = px.reduce((a, b) => Math.max(a, b), 0) || OVERLAY_FACE_PX.here;
  const row = px.length
    ? px.reduce((a, b) => a + b, 0) + (px.length - 1) * FACE_GAP
    : OVERLAY_FACE_PX.here;
  // ALWAYS as wide as the chrome, hovered or not. Growing sideways on hover
  // slid the circles out from under the pointer, the chrome then hid, the
  // window shrank, the circles slid back, and the loop read as a flicker. The
  // extra width at rest is transparent, click-through glass: it costs nothing.
  const width = Math.max(row, CHROME_WIDTH);
  const card = opts?.actions ? PRESENCE_CARD_ACTIONS : opts?.hovered ? PRESENCE_CARD : 0;
  return {
    width: Math.round(width + FACES_PADDING * 2),
    height: Math.round(tallest + (card ? ROW_GAP + card : 0) + FACES_PADDING * 2),
  };
}

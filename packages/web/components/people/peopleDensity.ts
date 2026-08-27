// How much of itself the people window shows, decided by its own size.
//
// The window is resized by hand and remembered per machine, so which layout
// fits is a fact about the window, never a preference: a person who drags it
// down to a sliver wants a sliver that still works. Three shapes, chosen from
// the measured box (CSS pixels, after zoom) and nothing else. React-free so
// the thresholds are unit-testable under bun.

export type PeopleDensity = "strip" | "compact" | "full";

/** Below this height there is no room for a header AND a list: the window is
 *  one row of faces. 36px of titlebar band plus one face row plus breathing. */
export const STRIP_MAX_H = 120;

/** Narrower than this, the full header does not fit: on the desktop its top
 *  row carries the 78px traffic-light inset plus the title, the two-word
 *  view switch and the pin, which is ~255px before the name row below gets a
 *  say. Measured in CSS pixels AFTER the desktop's zoom, so a 320pt window
 *  at a 1.25 zoom is 256 wide here and folds, which is right — the same
 *  boxes genuinely do not fit in 256. */
export const COMPACT_MAX_W = 260;

/** Shorter than this, the full header eats too much of the list. */
export const COMPACT_MAX_H = 360;

export function densityFor(width: number, height: number): PeopleDensity {
  if (height < STRIP_MAX_H) return "strip";
  if (width < COMPACT_MAX_W || height < COMPACT_MAX_H) return "compact";
  return "full";
}

import type { WallTier } from "./peopleWallLayout";

/** Face sizes for the strip: the wall's tiers, shrunk to fit one row. The
 *  ORDER of sizes is the wall's, so the biggest face is still the person most
 *  worth a word — only the scale changes. `gone` is typed so the table is
 *  total, and drawn only when the offline fold is opened. */
export const STRIP_FACE_PX: Record<WallTier, number> = {
  loud: 34,
  here: 28,
  idle: 24,
  away: 20,
  gone: 20,
};

/** The strip's row height: anchored to the TOP of the window rather than
 *  centred in it, so a window dragged taller (but still under STRIP_MAX_H)
 *  keeps its faces beside the traffic lights instead of floating mid-box.
 *  48px holds the 34px loud face with its rings and roughly centres on the
 *  lights (y 12..24). */
export const STRIP_ROW_H = 48;

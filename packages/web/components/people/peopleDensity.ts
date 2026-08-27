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

/** Narrower than this, a two-line header with three status pills and a row
 *  of actions does not fit; the header folds to one line and rows tighten.
 *  Measured in CSS pixels AFTER the desktop's zoom, so a 320pt window at a
 *  1.25 zoom is 256 wide here and still full; at 1.5 it is 213 and folds,
 *  which is right — three pills genuinely do not fit in 213. */
export const COMPACT_MAX_W = 240;

/** Shorter than this, the full header eats too much of the list. */
export const COMPACT_MAX_H = 360;

export function densityFor(width: number, height: number): PeopleDensity {
  if (height < STRIP_MAX_H) return "strip";
  if (width < COMPACT_MAX_W || height < COMPACT_MAX_H) return "compact";
  return "full";
}

/** Face sizes for the strip: the wall's tiers, shrunk to fit one row. The
 *  ORDER of sizes is the wall's, so the biggest face is still the person most
 *  worth a word — only the scale changes. `gone` faces fold into a count. */
export const STRIP_FACE_PX = {
  loud: 34,
  here: 28,
  idle: 24,
  away: 20,
} as const;

export type StripTier = keyof typeof STRIP_FACE_PX;

/** The strip's own height budget at each face size, so the row centres on the
 *  traffic lights (y 12..24 → centre 18) when the window is at its minimum. */
export const STRIP_ROW_H = 44;

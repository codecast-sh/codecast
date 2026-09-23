// THE TIMING OF A SURFACE CHANGING SHAPE.
//
// A reorder on the face row (components/faces/FaceRow) is a FLIP, transform
// only, and these are its numbers: one duration and one curve for every
// surface that moves, so a face travelling along the header and a face
// travelling in the floating window read as the same motion. Reduced motion
// is not a shorter animation, it is no animation: the new shape is simply
// there. Nothing here is load-bearing for correctness, so skipping it is free.

/** 240ms, the duration the plan asked for: long enough to read as one thing
 *  moving, short enough that nobody waits for it. About 14 frames at 60Hz. */
export const MORPH_MS = 240;

/** Out of the gate fast, settling slow: a thing arriving, not a thing easing. */
export const MORPH_EASING = "cubic-bezier(0.2, 0.7, 0.3, 1)";

/** Motion is off, or the browser cannot animate: either way, no morph. */
export function canMorph(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

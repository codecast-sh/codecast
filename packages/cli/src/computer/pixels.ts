/**
 * What the target window's pixels say about an action.
 *
 * The helper captures the window just before the action and just after it,
 * and, when those differ, once more a moment later. Two regions come back:
 * where the first pair differs, and where the last pair does. This decides
 * what they mean, for both helpers, in one place.
 *
 * It matters only when the tree shows no change. Then the pixels separate
 * input that was dropped from input that changed something the tree does not
 * expose (a canvas, a drawing, a terminal), which used to cost a screenshot.
 */

import type { ComputerPixelChange, ComputerRect } from "./types.js";

export type PixelVerdict =
  | { state: "unchanged" }
  /** Only a blinking text cursor moved: as good as unchanged. */
  | { state: "cursor"; region: ComputerRect }
  | { state: "changed"; region: ComputerRect }
  /** The window kept changing by itself (a spinner, a video, a clock), so a
   *  difference across the action says nothing about the action. */
  | { state: "repainting"; region: ComputerRect };

/** A text cursor: a sliver a few points wide and no taller than a line or two. */
function cursorShaped(r: ComputerRect): boolean {
  return r.width <= 3 && r.height <= 40;
}

export function pixelVerdict(change: ComputerPixelChange | undefined): PixelVerdict | undefined {
  if (!change) return undefined;
  const { changed, repainting } = change;
  if (!changed) return { state: "unchanged" };
  if (cursorShaped(changed)) return { state: "cursor", region: changed };
  // A cursor blinking between the second and third capture is not the window
  // repainting itself.
  if (repainting && !cursorShaped(repainting)) return { state: "repainting", region: repainting };
  return { state: "changed", region: changed };
}

export function describeRegion(r: ComputerRect): string {
  return `${r.x},${r.y} (${r.width}x${r.height})`;
}

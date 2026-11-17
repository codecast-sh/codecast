/**
 * Which way a simulator is turned, and what that does to coordinates.
 *
 * A turned device keeps its portrait panel: its framebuffer stays portrait
 * and an app draws sideways into it, and the HID touch digitizer (what axe
 * and the stream helper send to) is in the panel's portrait points too. What
 * a person or an agent sees is the interface: upright, in the device's
 * orientation, and `describe-ui` answers in those coordinates. So every
 * coordinate read off a screen is the interface's, and turns into the panel's
 * only where a touch is sent. The stream helper does the same mapping natively
 * (simstream.m toPanel); the pair are pinned against each other by the tests.
 */

import type { SimOrientation } from "./pool.js";

/** One quarter turn of the device, the way Simulator.app's Rotate Left and Right go. */
export function turned(from: SimOrientation, direction: "left" | "right"): SimOrientation {
  // Turning the device left (counterclockwise) from portrait is landscape left.
  const left: Record<SimOrientation, SimOrientation> = { 1: 3, 3: 2, 2: 4, 4: 1 };
  const right: Record<SimOrientation, SimOrientation> = { 1: 4, 4: 2, 2: 3, 3: 1 };
  return (direction === "left" ? left : right)[from];
}

export function isSideways(o: SimOrientation): boolean {
  return o === 3 || o === 4;
}

/**
 * A point in the upright interface, on the portrait panel. `ui` is the
 * interface's size in points (describe-ui's root frame), already turned.
 */
export function toPanel(x: number, y: number, o: SimOrientation, ui: { width: number; height: number }): { x: number; y: number } {
  // The panel's portrait size: the interface's, unturned.
  const W = isSideways(o) ? ui.height : ui.width;
  const H = isSideways(o) ? ui.width : ui.height;
  switch (o) {
    case 2:
      return { x: W - x, y: H - y };
    case 3:
      return { x: W - y, y: x };
    case 4:
      return { x: y, y: H - x };
    default:
      return { x, y };
  }
}

/** Degrees clockwise (sips -r) that stand a portrait panel capture upright. */
export function uprightDegrees(o: SimOrientation): number {
  return o === 3 ? 270 : o === 4 ? 90 : o === 2 ? 180 : 0;
}

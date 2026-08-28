// THE DOCK CANNOT BE OFF THE SCREEN.
//
// It was, and this is the shape of how: the old placement asked
// `window.innerWidth` once, at the moment a burst became a call, and stored the
// answer as a LEFT coordinate. A1's rig measured x=1878 in a 1280-wide window —
// a dock placed for a 1920 screen, on a screen that was no longer 1920, with
// nothing anywhere that would ever recompute it.
//
// A corner offset cannot go stale that way, because it is measured from the
// edge the surface is anchored to rather than from the one it is furthest from.
// These tests pin both halves: the offset survives a resize, and `clampCorner`
// is what makes it survive a resize it could not survive on its own.
import { describe, expect, test } from "bun:test";
import {
  DOCK_SIZE,
  EDGE_MARGIN,
  HOME_CORNER,
  clampCorner,
  clampSize,
  cornerRect,
  forgetPlacement,
  onScreen,
  savePlacement,
  savedPlacement,
} from "./callSurfacePlacement";

const WIDE = { width: 1920, height: 1080 };
const NARROW = { width: 1280, height: 800 };

describe("the corner keeps the surface on screen", () => {
  test("a dock placed on a 1920 screen is still on a 1280 one (the x=1878 case)", () => {
    const corner = clampCorner(HOME_CORNER, DOCK_SIZE, WIDE);
    expect(onScreen(cornerRect(corner, DOCK_SIZE, WIDE), WIDE)).toBe(true);

    // The window narrows. Nothing about the stored placement changes — that is
    // the point of measuring from the corner — and the surface is still whole.
    const after = clampCorner(corner, DOCK_SIZE, NARROW);
    const rect = cornerRect(after, DOCK_SIZE, NARROW);
    expect(after).toEqual(corner);
    expect(onScreen(rect, NARROW)).toBe(true);
    expect(rect.left).toBe(NARROW.width - HOME_CORNER.right - DOCK_SIZE.width);
    expect(rect.left + rect.width).toBeLessThanOrEqual(NARROW.width);
  });

  test("a dock dragged to the far side of a wide screen is pulled back in", () => {
    // Dragged almost to the left edge of the 1920 window: 1500px of gap on its
    // right. That gap does not exist in a 1280 window, so the clamp takes it.
    const dragged = { right: 1500, bottom: 60 };
    expect(onScreen(cornerRect(dragged, DOCK_SIZE, WIDE), WIDE)).toBe(true);

    const after = clampCorner(dragged, DOCK_SIZE, NARROW);
    expect(after.right).toBe(NARROW.width - DOCK_SIZE.width - EDGE_MARGIN);
    expect(onScreen(cornerRect(after, DOCK_SIZE, NARROW), NARROW)).toBe(true);
  });

  test("every offset is clamped, in both directions, on every axis", () => {
    const off = clampCorner({ right: -400, bottom: -400 }, DOCK_SIZE, NARROW);
    expect(off).toEqual({ right: EDGE_MARGIN, bottom: EDGE_MARGIN });

    const far = clampCorner({ right: 9999, bottom: 9999 }, DOCK_SIZE, NARROW);
    expect(onScreen(cornerRect(far, DOCK_SIZE, NARROW), NARROW)).toBe(true);
  });

  test("a viewport smaller than the surface keeps the near edge rather than the far one", () => {
    // No placement can show all of it, so the margin wins: the controls stay
    // under the pointer instead of being pushed off the side it is anchored to.
    const tiny = { width: 200, height: 150 };
    expect(clampCorner(HOME_CORNER, DOCK_SIZE, tiny)).toEqual({
      right: EDGE_MARGIN,
      bottom: EDGE_MARGIN,
    });
  });

  test("the size is clamped to the screen too, and never below the minimum", () => {
    expect(clampSize({ width: 2000, height: 2000 }, NARROW)).toEqual({
      width: NARROW.width - 2 * EDGE_MARGIN,
      height: NARROW.height - 2 * EDGE_MARGIN,
    });
    expect(clampSize({ width: 10, height: 10 }, NARROW)).toEqual({ width: 240, height: 180 });
  });
});

describe("where the person left it", () => {
  test("a placement outlives the call that was dragged, and a call is where the last one was", () => {
    forgetPlacement();
    expect(savedPlacement()).toBeNull();
    savePlacement({ right: 300, bottom: 200 }, DOCK_SIZE);
    expect(savedPlacement()).toEqual({ corner: { right: 300, bottom: 200 }, size: DOCK_SIZE });
    forgetPlacement();
  });
});

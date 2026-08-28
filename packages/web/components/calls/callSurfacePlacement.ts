// WHERE THE CALL SURFACE SITS, as a distance from a corner rather than a point
// on a screen.
//
// The strip and the dock share one home: the bottom-right corner, one rem in
// and five rem up, which is where the walkie strip has always been and where
// the unpinned pill sits. Sharing it is what lets a burst become a call without
// the eye moving — the surface changes shape in place instead of jumping.
//
// AND THE CORNER IS WHY THE DOCK CANNOT LEAVE THE SCREEN. The old placement
// froze a LEFT/TOP point at the moment of the upgrade, read off
// `window.innerWidth` once; a window narrowed afterwards left that point
// outside the viewport (measured at x=1878 in a 1280-wide window) and nothing
// ever recomputed it. An offset from the bottom-right edge is meaningful in
// every viewport, and `clampCorner` below is applied on every layout rather
// than once, so there is no moment at which the stored placement can be wrong.

export type Corner = { right: number; bottom: number };
export type Size = { width: number; height: number };
export type Viewport = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };

/** The strip's corner, in pixels: `right: 1rem`, `bottom: 5rem` (walkie.css). */
export const HOME_CORNER: Corner = { right: 16, bottom: 80 };

/** The smallest gap between the surface and the edge of the screen. */
export const EDGE_MARGIN = 8;

/** The floating dock at rest, and the smallest it can be dragged to. */
export const DOCK_SIZE: Size = { width: 320, height: 250 };
export const DOCK_MIN: Size = { width: 240, height: 180 };

/** The strip's width. Wider than the dock because it holds three decisions. */
export const STRIP_WIDTH = 420;

/**
 * The corner, made safe for the viewport it is about to be used in.
 *
 * Both offsets are held between the margin and "the far edge minus the
 * surface", so the surface is always fully on screen. When the viewport is
 * smaller than the surface itself that range is empty; the margin wins and the
 * surface overflows the far edge, which keeps the controls under the pointer
 * rather than pushing them off the near one.
 */
export function clampCorner(corner: Corner, size: Size, vp: Viewport, margin = EDGE_MARGIN): Corner {
  const limit = (offset: number, extent: number, span: number) =>
    Math.max(margin, Math.min(offset, span - extent - margin));
  return {
    right: limit(corner.right, size.width, vp.width),
    bottom: limit(corner.bottom, size.height, vp.height),
  };
}

/** A surface never wider or taller than the screen it is on. */
export function clampSize(size: Size, vp: Viewport, margin = EDGE_MARGIN): Size {
  return {
    width: Math.max(DOCK_MIN.width, Math.min(size.width, vp.width - 2 * margin)),
    height: Math.max(DOCK_MIN.height, Math.min(size.height, vp.height - 2 * margin)),
  };
}

/** The corner read back as a screen rectangle — what a test can check for. */
export function cornerRect(corner: Corner, size: Size, vp: Viewport): Rect {
  return {
    left: vp.width - corner.right - size.width,
    top: vp.height - corner.bottom - size.height,
    width: size.width,
    height: size.height,
  };
}

/** Is the whole surface inside the viewport? */
export function onScreen(rect: Rect, vp: Viewport): boolean {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.left + rect.width <= vp.width &&
    rect.top + rect.height <= vp.height
  );
}

// ── Where the person left it ────────────────────────────────────────────────
//
// The dock is mounted for the length of a call and unmounted between calls, so
// component state forgets the drag the moment a call ends. This remembers it
// for as long as the page is open — which is what "where I put it" means to a
// person on a call, and no longer. Deliberately not persisted: a placement that
// outlives the tab is a preference nobody set.

let placed: { corner: Corner; size: Size } | null = null;

export function savedPlacement(): { corner: Corner; size: Size } | null {
  return placed;
}

export function savePlacement(corner: Corner, size: Size): void {
  placed = { corner, size };
}

/** Tests, and the end of a call: forget the drag. */
export function forgetPlacement(): void {
  placed = null;
}

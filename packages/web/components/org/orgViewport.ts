// The org canvas viewport: where the tree sits and which roots are off screen.
import type { Viewport } from "@xyflow/react";
import type { OrgLayoutNode } from "./orgLayout";

/** Below this zoom a 13px session title renders under 12px: not readable.
 *  Rather than fit the whole tree that small, fit the root tier and pan. */
export const MIN_READABLE_ZOOM = 0.92;
export const FIT_PAD = 24;
const ROOT_KINDS = new Set(["person", "role"]);

type Rect = { x: number; y: number; w: number; h: number };
/** What the fit reads off a node: either lens' layout hands these. */
export type OrgViewportNode = Rect & { id: string; kind: string };
function boundsOf(nodes: readonly OrgViewportNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The viewport for a canvas of `width` x `height` with `panelWidth` covered on
 * the right (the desktop panel) and `panelHeight` covered at the bottom (the
 * phone sheet). The tree is anchored to the TOP of the free area, never centred
 * vertically: the root row belongs next to the toolbar. If the whole tree only
 * fits below MIN_READABLE_ZOOM, the root tier (people, roles, anchors) is
 * fitted instead, at readable size, centred on `focusId` when it is wider than
 * the free area.
 */
export function computeOrgViewport(
  nodes: readonly OrgViewportNode[],
  width: number,
  height: number,
  panelWidth: number,
  focusId: string | null,
  /** A card to bring to the centre of the free area (a focused ghost), at
   *  the viewer's current zoom when given, else at the fitted one. The tree
   *  is not refitted around it: only the pan changes. */
  focusTarget?: { id: string; zoom?: number } | null,
  panelHeight = 0,
  /** The least zoom the fit settles for before it shows the roots alone. The
   *  health map draws structure only, so it fits the whole tree smaller. */
  readableZoom = MIN_READABLE_ZOOM,
): { x: number; y: number; zoom: number; whole: boolean } | null {
  const all = boundsOf(nodes);
  if (!all || width <= 0 || height <= 0) return null;
  const freeW = Math.max(120, width - panelWidth - FIT_PAD * 2);
  const freeH = Math.max(120, height - panelHeight - FIT_PAD * 2);
  let zoom = Math.min(1, freeW / all.w, freeH / all.h);
  const focus = focusTarget ? nodes.find((n) => n.id === focusTarget.id) : undefined;
  if (focus) {
    const z = focusTarget?.zoom ?? Math.max(zoom, readableZoom);
    return {
      x: FIT_PAD + (freeW - focus.w * z) / 2 - focus.x * z,
      y: FIT_PAD + (freeH - focus.h * z) / 2 - focus.y * z,
      zoom: z,
      whole: false,
    };
  }
  let target = all;
  let whole = true;
  if (zoom < readableZoom) {
    const roots = boundsOf(nodes.filter((n) => ROOT_KINDS.has(n.kind))) ?? all;
    target = roots;
    whole = false;
    zoom = Math.max(readableZoom, Math.min(1, freeW / roots.w));
  }
  const tw = target.w * zoom;
  let x: number;
  if (tw <= freeW) {
    x = FIT_PAD + (freeW - tw) / 2 - target.x * zoom;
  } else {
    // Wider than the free area: start from the left edge so as many roots as
    // possible show (the viewer sorts first), unless the focus node would then
    // be off screen, in which case bring it into view at the left.
    const focus = focusId ? nodes.find((n) => n.id === focusId) : undefined;
    const startX = focus && (focus.x + focus.w) * zoom > freeW ? focus.x : target.x;
    x = FIT_PAD - startX * zoom;
  }
  const y = FIT_PAD - target.y * zoom;
  return { x, y, zoom, whole };
}


type Rect = { id: string; x: number; y: number; w: number; h: number };

/**
 * Where a new layout's origin goes so the card the person is pointing at does
 * not move (orgZoom): each zoom level is laid out at its own card sizes, and
 * crossing a stop swaps one layout for the other. The anchor is the card
 * under `point` in the layout on screen (`prev`, already at its origin), else
 * the one nearest it; `next` is the new layout at the zero origin. The cards
 * then slide to their places around the anchor, and the canvas is not moved.
 */
export function bandOrigin(prev: readonly Rect[], next: readonly Rect[], point: { x: number; y: number }): { x: number; y: number } {
  const to = new Map(next.map((n) => [n.id, n]));
  const away = (n: Rect) => Math.hypot(Math.max(n.x - point.x, 0, point.x - (n.x + n.w)), Math.max(n.y - point.y, 0, point.y - (n.y + n.h)));
  let anchor: Rect | null = null, best = Infinity;
  for (const n of prev) {
    if (!to.has(n.id)) continue;
    const d = away(n);
    if (d < best) { best = d; anchor = n; }
  }
  if (!anchor) return { x: 0, y: 0 };
  const n = to.get(anchor.id)!;
  return { x: anchor.x - n.x, y: anchor.y - n.y };
}

/** Root cards fully outside the free canvas on each side, for the edge cues. */
export function hiddenRoots(nodes: OrgLayoutNode[], vp: Viewport, freeW: number): { left: OrgLayoutNode[]; right: OrgLayoutNode[] } {
  // The top row, wherever the layout's origin sits (bandOrigin moves it).
  const top = Math.min(...nodes.map((n) => n.y));
  const roots = nodes.filter((n) => n.y === top);
  const left: OrgLayoutNode[] = [];
  const right: OrgLayoutNode[] = [];
  for (const n of roots) {
    const x0 = n.x * vp.zoom + vp.x;
    const x1 = (n.x + n.w) * vp.zoom + vp.x;
    if (x1 <= 0) left.push(n);
    else if (x0 >= freeW) right.push(n);
  }
  left.sort((a, b) => b.x - a.x);
  right.sort((a, b) => a.x - b.x);
  return { left, right };
}

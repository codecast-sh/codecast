// The org canvas viewport: where the tree sits and which roots are off screen.
import type { Viewport } from "@xyflow/react";
import type { OrgLayoutNode } from "./orgLayout";

/** Below this zoom a 13px session title renders under 12px: not readable.
 *  Rather than fit the whole tree that small, fit the root tier and pan. */
export const MIN_READABLE_ZOOM = 0.92;
export const FIT_PAD = 24;
const ROOT_KINDS = new Set(["person", "role"]);

type Rect = { x: number; y: number; w: number; h: number };
type IdRect = Rect & { id: string };
/** What the fit reads off a node: either lens' layout hands these. */
export type OrgViewportNode = Rect & { id: string; kind: string };
function boundsOf(nodes: readonly OrgViewportNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The column a fit settles for when the whole tree is too small to read:
 *  the root tier of the people chart, or the outline of the goals map (every
 *  card but the owners column, which stays reachable by a pan or the People
 *  filter). `whole` when the tree fits readably as it is. */
export function fitTarget(
  nodes: readonly OrgViewportNode[],
  freeW: number,
  freeH: number,
  readableZoom = MIN_READABLE_ZOOM,
): { rect: Rect; zoom: number; whole: boolean } | null {
  const all = boundsOf(nodes);
  if (!all) return null;
  const zoom = Math.min(1, freeW / all.w, freeH / all.h);
  if (zoom >= readableZoom) return { rect: all, zoom, whole: true };
  const roots = boundsOf(nodes.filter((n) => ROOT_KINDS.has(n.kind)));
  // Both columns of the goals map need the width at the readable floor; when
  // they do not have it, the outline is what the fit shows first.
  const spine = !roots && nodes.some((n) => n.kind === "owner") && all.w * readableZoom > freeW ? boundsOf(nodes.filter((n) => n.kind !== "owner")) : null;
  const rect = roots ?? spine ?? all;
  const byWidth = Math.min(1, freeW / rect.w);
  if (byWidth >= readableZoom) return { rect, zoom: byWidth, whole: false };
  // Even that column is wider than the pane at the floor, so shrinking buys
  // nothing: read as large as the height allows (a shallow, wide org at full
  // size), start at the left, and let the edge pills reach the rest.
  return { rect, zoom: Math.max(readableZoom, Math.min(1, freeH / all.h)), whole: false };
}

/**
 * The viewport for a canvas of `width` x `height` with `panelWidth` covered on
 * the right (the desktop panel) and `panelHeight` covered at the bottom (the
 * phone sheet). The tree is anchored to the TOP of the free area, never centred
 * vertically: the root row belongs next to the toolbar. If the whole tree only
 * fits below `readableZoom`, one column is fitted instead (fitTarget), at
 * readable size, starting from `focusId` when the row is wider than the free
 * area.
 */
export function computeOrgViewport(
  nodes: readonly OrgViewportNode[],
  width: number,
  height: number,
  panelWidth: number,
  focusId: string | null,
  panelHeight = 0,
  /** The least zoom the fit settles for before it shows one column alone. The
   *  health map draws structure only, so it fits the whole tree smaller. */
  readableZoom = MIN_READABLE_ZOOM,
): { x: number; y: number; zoom: number; whole: boolean } | null {
  if (width <= 0 || height <= 0) return null;
  const freeW = Math.max(120, width - panelWidth - FIT_PAD * 2);
  const freeH = Math.max(120, height - panelHeight - FIT_PAD * 2);
  const fit = fitTarget(nodes, freeW, freeH, readableZoom);
  if (!fit) return null;
  const { rect: target, zoom, whole } = fit;
  const all = boundsOf(nodes)!;
  let x: number;
  if (all.w * zoom <= freeW) {
    x = FIT_PAD + (freeW - all.w * zoom) / 2 - all.x * zoom;
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

/** The pan along one axis that brings a span of `size` at `pos` into
 *  `extent`, landing FIT_PAD inside the edge it was past (the near edge wins
 *  when it cannot fit whole), then held to the tree: a tree longer than the
 *  area never leaves a blank strip at its start or end, and a tree that fits
 *  is never pushed out. Zero when the span is already inside. */
function axisPan(pos: number, size: number, treePos: number, treeSize: number, extent: number): number {
  if (pos >= 0 && pos + size <= extent) return 0;
  let d = pos + size > extent ? extent - FIT_PAD - (pos + size) : 0;
  if (pos + d < FIT_PAD) d = FIT_PAD - pos;
  return holdToTree(d, treePos, treeSize, extent);
}

/** The pan that puts a span's centre in the middle of `extent`, held to the
 *  tree the same way (a card near the tree's end stops short of the middle). */
function axisCenter(pos: number, size: number, treePos: number, treeSize: number, extent: number): number {
  return holdToTree(extent / 2 - (pos + size / 2), treePos, treeSize, extent);
}

/** A pan `d` corrected so the tree never leaves a blank strip at its start or
 *  end when it is longer than `extent`, and never leaves the area when not. */
function holdToTree(d: number, treePos: number, treeSize: number, extent: number): number {
  const t0 = treePos + d, t1 = treePos + treeSize + d;
  if (treeSize > extent - FIT_PAD * 2) {
    if (t0 > FIT_PAD) d += FIT_PAD - t0;
    else if (t1 < extent - FIT_PAD) d += extent - FIT_PAD - t1;
  } else if (t0 < FIT_PAD) d += FIT_PAD - t0;
  else if (t1 > extent - FIT_PAD) d += extent - FIT_PAD - t1;
  return d;
}

/**
 * The viewport that shows the card `targetId` (a focused change, a hovered
 * card, a link's node) at the viewer's zoom, moving as little as it can: a
 * card already fully inside the free area (`free`: left of the panel, above
 * the sheet) is left where it is, so a focus never re-centres what the
 * person can see; one past an edge moves just far enough to land FIT_PAD
 * inside it, on that axis alone. The pan is clamped to the tree (axisPan),
 * so a tree wider than the pane never strands its left edge right of
 * FIT_PAD with half the picture off screen. Null when nothing need move.
 *
 * `center` is for the card whose sheet is open (D3): the sheet leaves a
 * narrow strip, and the far edge of it sits under the sheet's shadow, so the
 * card goes to the middle of the strip across, held to the tree, and the
 * zoom rises to MIN_READABLE_ZOOM (about the card) when it is below it.
 * Down the page it still moves by the least, so the root row stays put.
 */
export function panIntoView(
  nodes: readonly OrgViewportNode[],
  targetId: string,
  vp: Viewport,
  free: { w: number; h: number },
  mode: "least" | "center" = "least",
): Viewport | null {
  const n = nodes.find((b) => b.id === targetId);
  const all = boundsOf(nodes);
  if (!n || !all) return null;
  let at = vp;
  if (mode === "center" && vp.zoom < MIN_READABLE_ZOOM) {
    // Zoom about the card's centre, so the pans below start from where it is.
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, z = MIN_READABLE_ZOOM;
    at = { x: cx * vp.zoom + vp.x - cx * z, y: cy * vp.zoom + vp.y - cy * z, zoom: z };
  }
  const z = at.zoom;
  const across = mode === "center" ? axisCenter : axisPan;
  let dx = across(n.x * z + at.x, n.w * z, all.x * z + at.x, all.w * z, free.w);
  const dy = axisPan(n.y * z + at.y, n.h * z, all.y * z + at.y, all.h * z, free.h);
  // Already centred to the pixel: a re-run on a panel change does not nudge.
  if (Math.abs(dx) < 0.5) dx = 0;
  if (dx === 0 && dy === 0 && at === vp) return null;
  return { x: at.x + dx, y: at.y + dy, zoom: z };
}

/**
 * Where a new layout's origin goes so the card the person is pointing at does
 * not move (orgZoom): each zoom level is laid out at its own card sizes, and
 * crossing a stop swaps one layout for the other. The anchor is the card
 * under `point` in the layout on screen (`prev`, already at its origin), else
 * the one nearest it; `next` is the new layout at the zero origin. The cards
 * then slide to their places around the anchor, and the canvas is not moved.
 */
export function bandOrigin(prev: readonly IdRect[], next: readonly IdRect[], point: { x: number; y: number }): { x: number; y: number } {
  const to = new Map(next.map((n) => [n.id, n]));
  const away = (n: IdRect) => Math.hypot(Math.max(n.x - point.x, 0, point.x - (n.x + n.w)), Math.max(n.y - point.y, 0, point.y - (n.y + n.h)));
  let anchor: IdRect | null = null, best = Infinity;
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

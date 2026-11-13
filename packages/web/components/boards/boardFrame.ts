// What a board draws and frames, shared by the live view and the shared (public link) page.
import { connectorGeometry, elementBounds, unionBox, type Box } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

/** Draw order: frames under everything, then by z, ties by key. */
export function drawOrder(els: BoardEl[]): BoardEl[] {
  return [...els].sort((a, b) => {
    const fa = a.kind === "frame" ? 0 : 1, fb = b.kind === "frame" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const za = typeof a.z === "number" ? a.z : 0, zb = typeof b.z === "number" ? b.z : 0;
    return za - zb || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

/** What "fit" frames: every element, room above frames for their titles, and the comment pins. */
/** How far outside the content a comment pin may sit and still be framed by a fit. */
const PIN_REACH = 80;

export function fitBox(els: BoardEl[], byKey: Map<string, BoardEl>, pins: Iterable<{ x: number; y: number }> = []): Box | null {
  const boxes = els.flatMap((e) => {
    if (e.kind === "connector") {
      const g = connectorGeometry(e, (k) => byKey.get(k));
      return g ? [g.box] : [];
    }
    const b = elementBounds(e);
    return [e.kind === "frame" ? { ...b, y: b.y - 28, h: b.h + 28 } : b];
  });
  // A comment pin stands above and right of its point (about 30px on screen): room for it.
  // A pin out in empty space (an ask dropped before the drawing existed) does not stretch the frame:
  // only pins on or near the content count, so a finished board opens centred on what is drawn.
  const content = unionBox(boxes);
  const near = (p: { x: number; y: number }) => !content || (p.x >= content.x - PIN_REACH && p.x <= content.x + content.w + PIN_REACH && p.y >= content.y - PIN_REACH && p.y <= content.y + content.h + PIN_REACH);
  for (const p of pins) if (near(p)) boxes.push({ x: p.x, y: p.y - 36, w: 36, h: 36 });
  return unionBox(boxes);
}

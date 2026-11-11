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

/** What "fit" frames: every element, plus room above frames for their titles. */
export function fitBox(els: BoardEl[], byKey: Map<string, BoardEl>): Box | null {
  return unionBox(els.flatMap((e) => {
    if (e.kind === "connector") {
      const g = connectorGeometry(e, (k) => byKey.get(k));
      return g ? [g.box] : [];
    }
    const b = elementBounds(e);
    return [e.kind === "frame" ? { ...b, y: b.y - 28, h: b.h + 28 } : b];
  }));
}

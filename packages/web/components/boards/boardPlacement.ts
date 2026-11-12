// Where Tab puts the next sticky while typing: beside the one being written
// (Shift: below it), past anything already there. Inside a frame the row
// wraps at the frame's edge instead of running into the next frame, and the
// frame grows to hold the new sticky, as FigJam sections do. On an open
// canvas a row wraps after four.
import { contains, elementBounds, elementBox, type Box } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

const GAP = 24;
/** On an open canvas a row of Tab-made stickies wraps after this many, so a burst of ideas stays a readable block. */
const ROW = 4;

export function nextStickySpot(cur: Box, h: number, dir: 1 | -1, els: Iterable<BoardEl>): { x: number; y: number; growFrame?: { key: string; h: number } } {
  const all = [...els];
  const frame = all.find((e) => e.kind === "frame" && contains(elementBox(e), cur));
  const fb = frame ? elementBox(frame) : null;
  const taken = all.filter((o) => o.kind !== "frame" && o.kind !== "connector" && o.kind !== "pen").map(elementBounds);
  const hits = (s: { x: number; y: number }) => taken.some((t) => s.x < t.x + t.w - 1 && t.x + 1 < s.x + cur.w && s.y < t.y + t.h - 1 && t.y + 1 < s.y + h);
  // A row inside a frame starts where its first item does.
  const rowStart = fb ? Math.min(...taken.filter((t) => contains(fb, t)).map((t) => t.x), cur.x) : cur.x;
  let spot = { x: dir > 0 ? cur.x + cur.w + GAP : cur.x, y: dir > 0 ? cur.y : cur.y + cur.h + GAP };
  if (!fb && dir > 0) {
    // The row this sticky ends: the stickies just left of it, edge to edge, at its height.
    let start = cur.x, n = 1;
    for (;;) {
      const prev = taken.find((t) => Math.abs(t.y - cur.y) < 4 && Math.abs(t.x + t.w + GAP - start) < GAP);
      if (!prev) break;
      start = prev.x;
      n++;
    }
    if (n >= ROW) spot = { x: start, y: cur.y + h + GAP };
  }
  for (let i = 0; i < 60; i++) {
    if (fb && dir > 0 && spot.x + cur.w > fb.x + fb.w) spot = { x: rowStart, y: spot.y + h + GAP };
    if (!hits(spot)) break;
    spot = dir > 0 ? { ...spot, x: spot.x + cur.w + GAP } : { ...spot, y: spot.y + h + GAP };
  }
  const bottom = spot.y + h + GAP;
  return frame && fb && bottom > fb.y + fb.h ? { ...spot, growFrame: { key: frame.key, h: Math.round(bottom - fb.y) } } : spot;
}

// Which frame the pointer is over (pl-1145), for its Reflow and Collapse
// controls. Read from the pointer's position against the frames' boxes, not
// CSS :hover: a theme frame is mostly covered by its stickies and cards,
// which are the frame's siblings in the DOM. The board's own pointer-move
// handler feeds it; it re-renders only when the hovered frame changes.
import { useMemo, useRef, useState } from "react";
import { elementBounds, frameCollapsed, type Box, type Pt } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

/** How far above a frame its title and controls reach, in screen pixels at 100%: they scale up past 70% zoom out. */
const BAND_PX = 40;

/**
 * The innermost open frame whose box, or the band above it where its title and
 * controls sit, holds `p`. Innermost is the one a person is working in: a
 * nested frame's controls, not its parent's.
 */
export function frameAt(frames: readonly { key: string; box: Box }[], p: Pt, z: number): string | null {
  const band = BAND_PX * Math.max(1, 0.7 / z);
  let best: { key: string; area: number } | null = null;
  for (const f of frames) {
    const b = f.box;
    if (p.x < b.x || p.x > b.x + b.w || p.y < b.y - band || p.y > b.y + b.h) continue;
    const area = b.w * b.h;
    if (!best || area < best.area) best = { key: f.key, area };
  }
  return best?.key ?? null;
}

/** `shown`: what the canvas draws (folded-away elements already out). Pills have no hover controls. */
export function useFrameHover(shown: readonly BoardEl[]) {
  const frames = useMemo(() => shown.filter((e) => e.kind === "frame" && !frameCollapsed(e)).map((e) => ({ key: e.key, box: elementBounds(e) })), [shown]);
  const [hovered, setHovered] = useState<string | null>(null);
  const cur = useRef<string | null>(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const set = (k: string | null) => {
    if (k === cur.current) return;
    cur.current = k;
    setHovered(k);
  };
  return {
    hovered,
    /** A pointer at world point `p`, at zoom `z`. */
    move: (p: Pt, z: number) => set(frameAt(framesRef.current, p, z)),
    leave: () => set(null),
  };
}

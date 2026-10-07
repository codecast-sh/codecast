"use client";
// The arrows on a sideways scroller's hidden edges (useScrollEdges): the fade
// says there is more past the edge, the arrow says where and moves there.
// Shared by the map (line-map.md LX2) and the project pills. The buttons
// never take focus on click, so a click near the edge leaves the keyboard
// where it was.
import type { RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ScrollEdges } from "./useScrollEdges";

export function EdgeArrows({ scroller, edges, label, step = 0.7 }: {
  scroller: RefObject<HTMLElement | null>;
  edges: ScrollEdges;
  /** What the row holds, for the buttons' names: "the line", "projects". */
  label: string;
  /** How far one press moves, as a share of the visible width. */
  step?: number;
}) {
  const move = (dir: -1 | 1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * step, behavior: "smooth" });
  };
  return (
    <>
      {edges.left && (
        <button type="button" tabIndex={-1} className="line-edge-arrow" data-side="left" onMouseDown={(e) => e.preventDefault()} onClick={() => move(-1)} aria-label={`Scroll ${label} back`} title={`More of ${label} this way`} data-edge-arrow="left">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      {edges.right && (
        <button type="button" tabIndex={-1} className="line-edge-arrow" data-side="right" onMouseDown={(e) => e.preventDefault()} onClick={() => move(1)} aria-label={`Scroll ${label} on`} title={`More of ${label} this way`} data-edge-arrow="right">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  );
}

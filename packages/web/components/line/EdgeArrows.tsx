"use client";
// The arrows on a sideways scroller's hidden edges (useScrollEdges): the fade
// says there is more past the edge, the arrow says where and moves there.
// Shared by the map (line-map.md LX2) and the project pills. The buttons
// never take focus on click, so a click near the edge leaves the keyboard
// where it was.
import type { RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ScrollEdges } from "./useScrollEdges";

export function EdgeArrows({ scroller, edges, label, step = 0.7, waiting, names }: {
  scroller: RefObject<HTMLElement | null>;
  edges: ScrollEdges;
  /** What the row holds, for the buttons' names: "the line", "projects". */
  label: string;
  /** How far one press moves, as a share of the visible width. */
  step?: number;
  /** Cards waiting past each edge: the arrow carries their count in the ask color, so a clipped item that needs you still shows. */
  waiting?: { left: number; right: number };
  /** What lies past each edge, nearest first ("Build", "Check"): the arrow names it, so a reader knows the row goes on and to what. */
  names?: { left: string[]; right: string[] };
}) {
  const named = (list: string[] | undefined) => {
    if (!list?.length) return null;
    const shown = list.slice(0, 2).join(", ");
    return <span className="line-edge-names">{list.length > 2 ? `${shown} +${list.length - 2}` : shown}</span>;
  };
  const sayNames = (list: string[] | undefined) => (list?.length ? `: ${list.join(", ")}` : "");
  const badge = (n: number) => (n > 0 ? <span className="line-edge-count" data-edge-waiting={n}>{n}</span> : null);
  const say = (n: number) => (n > 0 ? `, ${n} ${n === 1 ? "decision" : "decisions"} waiting on you that way` : "");
  const move = (dir: -1 | 1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * step, behavior: "smooth" });
  };
  return (
    <>
      {edges.left && (
        <button type="button" tabIndex={-1} className="line-edge-arrow" data-side="left" onMouseDown={(e) => e.preventDefault()} onClick={() => move(-1)} aria-label={`Scroll ${label} back${sayNames(names?.left)}${say(waiting?.left ?? 0)}`} title={`More of ${label} this way${sayNames(names?.left)}${say(waiting?.left ?? 0)}`} data-edge-arrow="left" data-waiting={waiting?.left ? "true" : undefined} data-named={names?.left.length ? "true" : undefined}>
          <ChevronLeft className="w-3.5 h-3.5 shrink-0" />{named(names?.left)}{badge(waiting?.left ?? 0)}
        </button>
      )}
      {edges.right && (
        <button type="button" tabIndex={-1} className="line-edge-arrow" data-side="right" onMouseDown={(e) => e.preventDefault()} onClick={() => move(1)} aria-label={`Scroll ${label} on${sayNames(names?.right)}${say(waiting?.right ?? 0)}`} title={`More of ${label} this way${sayNames(names?.right)}${say(waiting?.right ?? 0)}`} data-edge-arrow="right" data-waiting={waiting?.right ? "true" : undefined} data-named={names?.right.length ? "true" : undefined}>
          {badge(waiting?.right ?? 0)}{named(names?.right)}<ChevronRight className="w-3.5 h-3.5 shrink-0" />
        </button>
      )}
    </>
  );
}

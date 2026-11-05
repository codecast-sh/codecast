"use client";
// The Graph view's overview (the Flows stage): the whole graph in a corner,
// drawn from the same layout as the canvas, each step a plain shape colored
// by what stands at it now (running, stalled, waiting on a person), and the
// part the stage shows outlined. A press moves the stage there. The outline
// follows the view by a DOM write from the view's own pan and zoom.
import { memo, type MouseEvent, type Ref } from "react";
import type { GraphLayout } from "./graphLayout";
import type { LiveAtStep } from "./GraphCanvas";

/** The overview's drawing box in px (graph.css .lwg-overview, less its padding), and a live marker's radius in it. */
const BOX = { w: 184, h: 100 };
const MARK_PX = 3.5;
const stateOf = (l: LiveAtStep | undefined) => (!l ? undefined : l.stalled ? "bad" : l.waiting ? "you" : l.running ? "live" : undefined);

export const GraphOverview = memo(function GraphOverview({ layout, live, viewRef, onJump }: {
  layout: GraphLayout; live: ReadonlyMap<string, LiveAtStep>; viewRef: Ref<SVGRectElement>; onJump: (x: number, y: number) => void;
}) {
  const b = layout.bounds;
  // Pixels of the overview per graph unit, so a marker keeps one size on screen.
  const scale = Math.min(BOX.w / (b.w + 40), BOX.h / (b.h + 40));
  const jump = (e: MouseEvent<SVGSVGElement>) => {
    e.stopPropagation();
    const m = e.currentTarget.getScreenCTM();
    if (!m) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    onJump(p.x, p.y);
  };
  return (
    <svg className="lwg-overview" viewBox={`${b.x - 20} ${b.y - 20} ${b.w + 40} ${b.h + 40}`} preserveAspectRatio="xMidYMid meet" onClick={jump} role="img" aria-label="The whole graph; press to move there" data-lwg-overview="">
      <g className="lwg-ov-edges">{layout.edges.map((e, i) => <path key={`${e.id}#${i}`} d={e.d} vectorEffect="non-scaling-stroke" />)}</g>
      <g className="lwg-ov-nodes">
        {layout.list.map((n) => (n.dot
          ? <circle key={n.id} cx={n.x} cy={n.y} r={10} />
          : <rect key={n.id} x={n.x - n.w / 2} y={n.y - n.h / 2} width={n.w} height={n.h} rx={12} />))}
      </g>
      {/* Each step holding runs as a marker of one size on screen, whatever the graph's: the piles read at a glance. */}
      <g className="lwg-ov-live">
        {layout.list.map((n) => {
          const st = stateOf(live.get(n.id));
          return st ? <circle key={n.id} cx={n.x} cy={n.y} r={MARK_PX / scale} data-state={st} /> : null;
        })}
      </g>
      <rect ref={viewRef} className="lwg-ov-view" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

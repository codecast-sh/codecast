// The span a day chart's brush covers (useDayBrush), drawn over the plot.

import type { BrushDrag } from "./useDayBrush";

/** The span a drag covers, from its first slot to its last. */
export function BrushRect({ drag, toX, top, height, className = "ev-brush" }: { drag: BrushDrag | null; toX: (i: number) => number; top: number; height: number; className?: string }) {
  if (!drag || drag.a === drag.b) return null;
  const x1 = toX(Math.min(drag.a, drag.b));
  const x2 = toX(Math.max(drag.a, drag.b));
  return <rect x={x1} y={top} width={x2 - x1} height={height} className={className} strokeWidth={0.5} pointerEvents="none" />;
}

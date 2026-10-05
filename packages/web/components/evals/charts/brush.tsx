// The drag-to-zoom brush a day chart shares: the seismograph's, and the app's
// activity charts' (ActivityCharts re-exports it with its own colours).

import { useRef, useState } from "react";

export interface BrushDrag {
  a: number;
  b: number;
}

/** Drag across a day chart to zoom into that span. Indices are plot slots;
 *  `pick` gets them ordered and only for a span of two or more slots. */
export function useDayBrush(pick: (a: number, b: number) => void) {
  // The ref is the truth (mouse events can outrun renders); state only paints.
  const ref = useRef<BrushDrag | null>(null);
  const [drag, setDrag] = useState<BrushDrag | null>(null);
  const set = (d: BrushDrag | null) => {
    ref.current = d;
    setDrag(d);
  };
  return {
    drag,
    start: (i: number) => set({ a: i, b: i }),
    move: (i: number) => {
      if (ref.current && ref.current.b !== i) set({ ...ref.current, b: i });
    },
    end: () => {
      const d = ref.current;
      if (d && d.a !== d.b) pick(Math.min(d.a, d.b), Math.max(d.a, d.b));
      set(null);
    },
    cancel: () => set(null),
  };
}

/** The span a drag covers, from its first slot to its last. */
export function BrushRect({ drag, toX, top, height, className = "ev-brush" }: { drag: BrushDrag | null; toX: (i: number) => number; top: number; height: number; className?: string }) {
  if (!drag || drag.a === drag.b) return null;
  const x1 = toX(Math.min(drag.a, drag.b));
  const x2 = toX(Math.max(drag.a, drag.b));
  return <rect x={x1} y={top} width={x2 - x1} height={height} className={className} strokeWidth={0.5} pointerEvents="none" />;
}

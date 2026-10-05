// The drag-to-zoom brush a day chart shares: the seismograph's, and the app's
// activity charts' (ActivityCharts re-exports it). BrushRect draws it.

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

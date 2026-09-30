import { useCallback, useRef, useState } from "react";

// The one drag-to-resize for a panel docked on the right whose LEFT edge is
// the handle: the chat thread panel, the comment rail, the call's thread
// rail. Dragging left grows the panel. The width is the reader's choice and
// persists per client under `storageKey`; a saved width outside [min, max]
// falls back to `fallback`.

export function loadEdgeWidth(storageKey: string, min: number, fallback: number, max = Infinity): number {
  if (typeof window === "undefined") return fallback;
  const v = Number(window.localStorage.getItem(storageKey));
  return v >= min && v <= max ? v : fallback;
}

export function useEdgeResize({
  storageKey,
  min,
  fallback,
  max = Infinity,
  initial,
  onCommit,
}: {
  storageKey: string;
  min: number;
  fallback: number;
  /** The upper bound, read when a drag starts: a number, or measured from the handle. */
  max?: number | ((handle: HTMLElement) => number);
  /** Seeds the width ahead of the saved one. */
  initial?: number;
  /** Runs once when a drag ends, with the final width. */
  onCommit?: (width: number) => void;
}) {
  const [width, setWidth] = useState(
    () => initial ?? loadEdgeWidth(storageKey, min, fallback, typeof max === "number" ? max : Infinity),
  );
  const dragging = useRef(false);

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const hi = Math.max(min, typeof max === "number" ? max : max(e.currentTarget));
      let latest = startW;
      dragging.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (ev: PointerEvent) => {
        latest = Math.min(hi, Math.max(min, startW + (startX - ev.clientX)));
        setWidth(latest);
      };
      const up = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.localStorage.setItem(storageKey, String(latest));
        onCommit?.(latest);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [width, min, max, storageKey, onCommit],
  );

  return { width, setWidth, dragging, onResizeDown };
}

/** The left-edge handle: invisible at rest, a hairline in `--edge-resize-accent`
 *  (cyan by default) on hover and drag. Its panel must be positioned. */
export function EdgeResizeHandle({ onResizeDown }: { onResizeDown: (e: React.PointerEvent<HTMLElement>) => void }) {
  return <div className="edge-resize" onPointerDown={onResizeDown} title="Drag to resize" />;
}

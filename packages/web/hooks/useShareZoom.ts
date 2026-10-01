// How a viewer looks at a screen share: fitted to the tile, at its real size
// (1:1, panned by dragging), or fullscreen. Text survives only near its own
// size: a 1440p share fitted into a 740px tile shrinks every 13px glyph to
// 4px, and no codec setting brings that back. At 1:1 the element is as large
// as the share, so adaptiveStream asks for the full layer by itself.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useWatchEffect } from "./useWatchEffect";

type Size = { width: number; height: number };

export function useShareZoom(
  boxRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  natural: Size | null,
  enabled: boolean,
) {
  const [actual, setActual] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useWatchEffect(() => {
    if (!enabled) return;
    const sync = () => setFullscreen(!!boxRef.current && document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [enabled, boxRef]);

  const canFullscreen = enabled && typeof document !== "undefined" && document.fullscreenEnabled;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    // A frameless see-through desktop window can refuse: then nothing happens.
    void boxRef.current?.requestFullscreen().catch(() => {});
  };

  // Device pixels to css pixels: one share pixel per screen pixel.
  const actualSize: Size | null =
    enabled && actual && natural
      ? { width: natural.width / window.devicePixelRatio, height: natural.height / window.devicePixelRatio }
      : null;

  // Drag to pan while at 1:1. Wheel and trackpad scroll the same box natively.
  const from = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const end = () => {
    from.current = null;
  };
  const panHandlers = actualSize
    ? {
        onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
          const el = scrollRef.current;
          if (!el || e.button !== 0) return;
          from.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
          el.setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
          const p = from.current;
          const el = scrollRef.current;
          if (!p || !el) return;
          el.scrollLeft = p.left - (e.clientX - p.x);
          el.scrollTop = p.top - (e.clientY - p.y);
        },
        onPointerUp: end,
        onPointerCancel: end,
      }
    : {};

  return {
    actual: !!actualSize,
    actualSize,
    toggleActual: () => setActual((a) => !a),
    fullscreen,
    canFullscreen,
    toggleFullscreen,
    panHandlers,
  };
}

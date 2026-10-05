// How a viewer looks at a screen share: fitted to the tile, at its real size
// (1:1, panned by dragging), or fullscreen. Text survives only near its own
// size: a 1440p share fitted into a 740px tile shrinks every 13px glyph to
// 4px, and no codec setting brings that back. At 1:1 the element is as large
// as the share, so adaptiveStream asks for the full layer by itself.
//
// An iPhone has no element fullscreen (Safari grants it on iPad only), which
// would leave a phone, where a guest most often is, with nothing but a 390px
// tile. There the video element's own fullscreen (webkitEnterFullscreen, the
// system player) stands in for it.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useWatchEffect } from "./useWatchEffect";

type Size = { width: number; height: number };

/** iOS Safari's fullscreen for a video element, the one it has on iPhone. */
type IosVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

export function useShareZoom(
  boxRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  natural: Size | null,
  enabled: boolean,
  videoRef?: RefObject<HTMLVideoElement | null>,
) {
  const [actual, setActual] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useWatchEffect(() => {
    if (!enabled) return;
    const video = videoRef?.current as IosVideo | null | undefined;
    const sync = () =>
      setFullscreen((!!boxRef.current && document.fullscreenElement === boxRef.current) || !!video?.webkitDisplayingFullscreen);
    document.addEventListener("fullscreenchange", sync);
    video?.addEventListener("webkitbeginfullscreen", sync);
    video?.addEventListener("webkitendfullscreen", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      video?.removeEventListener("webkitbeginfullscreen", sync);
      video?.removeEventListener("webkitendfullscreen", sync);
    };
  }, [enabled, boxRef, videoRef]);

  const elementFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;
  const iosVideo = (): IosVideo | null => {
    const v = videoRef?.current as IosVideo | null | undefined;
    return !elementFullscreen && typeof v?.webkitEnterFullscreen === "function" ? v : null;
  };
  const canFullscreen = enabled && (elementFullscreen || !!iosVideo());
  const toggleFullscreen = () => {
    const ios = iosVideo();
    if (ios) return void (ios.webkitDisplayingFullscreen ? ios.webkitExitFullscreen?.() : ios.webkitEnterFullscreen?.());
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    // A frameless see-through desktop window can refuse: then nothing happens.
    void boxRef.current?.requestFullscreen().catch(() => {});
  };

  // Device pixels to css pixels: one share pixel per screen pixel.
  const actualSize: Size | null =
    enabled && actual && natural
      ? { width: natural.width / window.devicePixelRatio, height: natural.height / window.devicePixelRatio }
      : null;

  // Drag to pan while at 1:1. Wheel and trackpad scroll the same box
  // natively, and so does a finger (the scroller's touch-action lets the
  // browser pan it), so a touch is left to the browser rather than also
  // dragged here, where the two would fight.
  const from = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const end = () => {
    from.current = null;
  };
  const panHandlers = actualSize
    ? {
        onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
          const el = scrollRef.current;
          if (!el || e.button !== 0 || e.pointerType === "touch") return;
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

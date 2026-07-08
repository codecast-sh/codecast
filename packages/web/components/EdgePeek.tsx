import { ReactNode, useCallback, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";

// Hover-peek state machine, shared by the left sidebar and the right session
// list. `open` drives the slide (CSS translateX); `mounted` lags it so the
// panel stays in the DOM through the exit transition instead of popping out.
export function useEdgePeek(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEnter = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setMounted(true);
    setOpen(true);
  }, []);
  const onLeave = useCallback(() => {
    setOpen(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMounted(false), 250);
  }, []);
  // Disabling the peek (panel re-expanded, mobile, zen) snaps it shut.
  useWatchEffect(() => {
    if (!enabled) {
      setOpen(false);
      setMounted(false);
    }
  }, [enabled]);
  return { open, mounted, onEnter, onLeave };
}

// Collapsed-panel hover-peek: an invisible edge hotzone that, on hover, slides a
// full panel out as an overlay and slides it back when the pointer leaves. The
// only per-side difference is geometry; all timing/animation is shared. Mount
// this inside a `relative` container so the overlay pins to that container's edge
// (not the viewport). Children mount only while peeking and unmount after the
// exit transition.
export function EdgePeek({
  side,
  enabled,
  width = 280,
  children,
}: {
  side: "left" | "right";
  enabled: boolean;
  width?: number;
  children: ReactNode;
}) {
  const { open, mounted, onEnter, onLeave } = useEdgePeek(enabled);
  if (!enabled) return null;
  const isLeft = side === "left";
  const edge = isLeft ? "left-0" : "right-0";
  const border = isLeft ? "border-r" : "border-l";
  const hidden = isLeft ? "-translate-x-full" : "translate-x-full";
  return (
    <>
      <div className={`absolute inset-y-0 ${edge} w-1.5 z-[80]`} onMouseEnter={onEnter} />
      <div
        className={`absolute inset-y-0 ${edge} z-[85] ${border} border-sol-border/50 bg-sol-bg-alt shadow-2xl transition-transform duration-200 ease-out ${open ? "translate-x-0" : `${hidden} pointer-events-none`}`}
        style={{ width }}
        onMouseLeave={onLeave}
      >
        {mounted && <div className="h-full overflow-auto">{children}</div>}
      </div>
    </>
  );
}

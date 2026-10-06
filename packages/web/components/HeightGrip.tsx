"use client";
// The bottom-edge resize grip: a full-width hit strip with a rounded bar,
// dragged to set the height of the element above it. Shared by the inline
// object reveal band and the published page embed. The height a reader drags
// to persists under a storage key, so every later frame of that kind opens
// at the reader's height.

import React, { useCallback } from "react";
import { cssZoomOf } from "../lib/cssZoom";
import { scrollParentOf } from "../lib/scrollWithin";

export { scrollParentOf };

/** A height that fits a frame's top and bottom in one view of its scrolling
 *  surface: the default a frame opens at. A drag is not held to it. */
export const maxGripHeight = (scroller: HTMLElement, min: number) => Math.max(min, scroller.clientHeight - 24);

export function savedGripHeight(key: string, min: number): number | null {
  try {
    const n = Number(localStorage.getItem(key));
    return n >= min ? n : null;
  } catch {
    return null;
  }
}

export function HeightGrip({ target, storageKey, min, onResized, className = "" }: {
  /** The element whose height the drag sets. Carries data-resizing while dragged. */
  target: React.RefObject<HTMLElement | null>;
  storageKey: string;
  min: number;
  onResized?: (height: number) => void;
  className?: string;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const el = target.current;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget;
      grip.setPointerCapture?.(e.pointerId);
      const zoom = cssZoomOf(el);
      const startY = e.clientY;
      const startH = el.getBoundingClientRect().height / zoom;
      const scroller = scrollParentOf(el);
      let h = startH;
      el.dataset.resizing = "";
      grip.dataset.resizing = "";
      const move = (ev: PointerEvent) => {
        const top = el.getBoundingClientRect().top;
        h = Math.max(min, startH + (ev.clientY - startY) / zoom);
        el.style.height = `${Math.round(h)}px`;
        // The grip is the bottom edge: keep the top of the frame where it was
        // so a drag moves the bottom, not the text the frame sits under.
        if (scroller) {
          const drift = (el.getBoundingClientRect().top - top) / zoom;
          if (Math.abs(drift) >= 1) scroller.scrollTop += drift;
        }
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        delete el.dataset.resizing;
        delete grip.dataset.resizing;
        const final = Math.round(h);
        try {
          localStorage.setItem(storageKey, String(final));
        } catch {}
        onResized?.(final);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    },
    [target, storageKey, min, onResized],
  );
  // A span, so the grip stays valid inside markdown's inline containers.
  return (
    <span
      className={`height-grip ${className}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag to resize"
      title="Drag to resize"
    >
      <span className="height-grip__bar" />
    </span>
  );
}

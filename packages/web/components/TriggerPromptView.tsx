"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";

// The full prompt is the trigger's contract — render it like a message body
// (first-class markdown prose), not a mono dump in a fixed crop. The viewport
// is user-resizable: drag the pill under the box. Height persists per device
// (unstamped ui pref — layout, not view state) and is shared by every trigger
// prompt surface, so one drag sets the reading depth everywhere.

const MIN_HEIGHT = 96;
const DEFAULT_HEIGHT = 240;
const MAX_HEIGHT = 1600;

export function TriggerPromptView({ prompt, className = "" }: { prompt: string; className?: string }) {
  const storedHeight = useInboxStore((s) => s.clientState.ui?.trigger_prompt_height);
  // Local height during the drag; the pref write happens once on release.
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragHeight ?? storedHeight ?? DEFAULT_HEIGHT));
  const boxRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<{ y: number; h: number } | null>(null);

  // True while content continues below the viewport's bottom edge — gates the
  // fade that makes the mid-line cut read as "more below", not a glitch.
  const [clipped, setClipped] = useState(false);
  const measureClipped = () => {
    const el = boxRef.current;
    if (el) setClipped(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  };
  useLayoutEffect(measureClipped, [prompt, height]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // Anchor on the RENDERED height: with short content the box sits below the
    // stored max, and anchoring there would make the first downward drag jump.
    dragFrom.current = { y: e.clientY, h: boxRef.current?.offsetHeight ?? height };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragFrom.current) return;
    const dy = e.clientY - dragFrom.current.y;
    // Dead zone: a click's jitter must not resize (or persist) anything.
    if (dragHeight === null && Math.abs(dy) < 3) return;
    setDragHeight(dragFrom.current.h + dy);
  };
  const onPointerUp = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    setDragHeight((h) => {
      if (h !== null) {
        useInboxStore.getState().updateClientUI({
          trigger_prompt_height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h)),
        });
      }
      return null;
    });
  };

  return (
    <div className={className}>
      <div className="relative">
        <div
          ref={boxRef}
          onScroll={measureClipped}
          // A document section, not an inset well: page background, full width,
          // hairlines top/bottom to mark where it starts and ends. Callers bleed
          // it edge-to-edge with a negative margin matching their padding.
          className="overflow-y-auto bg-sol-bg border-y border-sol-border/25 px-4 py-3"
          // max-height (not height) so a short prompt doesn't leave a hollow box;
          // the vh cap keeps a tall stored value from burying the conversation.
          style={{ maxHeight: `min(${height}px, 70vh)` }}
        >
          <MarkdownRenderer content={prompt} className="text-sm leading-relaxed text-sol-text" />
        </div>
        {clipped && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-px h-10"
            style={{ background: "linear-gradient(to bottom, transparent, var(--sol-bg))" }}
          />
        )}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="group flex h-4 cursor-row-resize touch-none select-none items-center justify-center"
        title="Drag to resize"
      >
        <span className="h-1.5 w-16 rounded-full bg-sol-border transition-colors group-hover:bg-sol-cyan/80 group-active:bg-sol-cyan" />
      </div>
    </div>
  );
}

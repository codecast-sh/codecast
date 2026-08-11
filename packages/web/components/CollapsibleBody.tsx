"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";

// A body that renders clipped to a short height with a fade at the cut, plus a
// toggle to open it. Machine-delivered blocks (trigger prompts, messages from
// other sessions) are often long briefings — at full height a single one buries
// the rest of the conversation, so they start collapsed.
//
// The fade is a mask, not a gradient overlay: these cards sit on tinted
// backgrounds (violet/5, cyan/5, bg-alt/30), and an overlay would have to be
// painted in each caller's exact background color. A mask fades the content
// itself, so one component works on any background.

const FADE_HEIGHT = 48;

// The fade itself, for callers that clip content their own way but want the
// same cut. Painting a scrim in the caller's background color is the trap this
// avoids: sol background tokens carry no alpha channel, so a `bg-sol-bg-alt/80`
// scrim compiles to nothing and the fade disappears silently.
export function clipFade(fadeHeight: number = FADE_HEIGHT) {
  const mask = `linear-gradient(to bottom, black calc(100% - ${fadeHeight}px), transparent)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

export function CollapsibleBody({
  collapsedHeight = 180,
  className = "",
  toggleClassName = "",
  children,
}: {
  collapsedHeight?: number;
  className?: string;
  toggleClassName?: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  // The clip lives on the outer box, so the inner box keeps its natural height
  // and measures the real content. Markdown settles over several frames (fonts,
  // images, code blocks), so the observer — not a dep on `children` — is what
  // catches the final size. Keeping `children` out of the deps also matters in a
  // transcript: it is a fresh object every render, and depending on it would
  // rebuild the observer on every parent re-render, on every mounted card.
  useWatchEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > collapsedHeight + 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsedHeight]);

  const clipped = overflows && !expanded;

  return (
    <div className={className}>
      <div
        style={
          clipped
            ? { maxHeight: collapsedHeight, overflow: "hidden", ...clipFade() }
            : undefined
        }
      >
        <div ref={innerRef}>{children}</div>
      </div>
      {overflows && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className={`flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors ${toggleClassName}`}
        >
          {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

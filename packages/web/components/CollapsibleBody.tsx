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

// The one-line sibling of CollapsibleBody: a label that clips with an ellipsis
// and opens on click. Machine notices (monitor events, task completions, the
// orphan scan's summary) put the whole story in one sentence, and the clipped
// tail is often the part that matters — but they sit inline in a transcript,
// where a row has to stay one line until the reader asks for more.
//
// The measurement runs only while collapsed. An expanded line wraps, so its
// scrollWidth equals its clientWidth; measuring then would decide the text no
// longer overflows and take the way back away.
export function ExpandableLine({
  text,
  className = "",
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLSpanElement>(null);

  useWatchEffect(() => {
    if (expanded) return;
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, text]);

  const openable = overflows || expanded;

  return (
    <span
      className={`min-w-0 flex-1 flex items-start gap-1 ${openable ? "cursor-pointer" : ""} ${className}`}
      onClick={
        openable
          ? (e) => {
              // These rows can sit inside a clickable card (a task line that
              // jumps to its child conversation) — opening the text is not
              // that navigation.
              e.stopPropagation();
              setExpanded((v) => !v);
            }
          : undefined
      }
      title={!expanded && overflows ? (title ?? text) : title}
    >
      <span ref={innerRef} className={expanded ? "whitespace-pre-wrap break-words" : "truncate"}>
        {text}
      </span>
      {openable &&
        (expanded ? (
          <ChevronUp className="w-3 h-3 shrink-0 mt-0.5 opacity-60" />
        ) : (
          <ChevronDown className="w-3 h-3 shrink-0 mt-0.5 opacity-60" />
        ))}
    </span>
  );
}

// `children` may be a function of the open state. A clipped box shows a few
// lines whatever its content, so a caller with an expensive body (markdown that
// re-parses on mount) can render a cheap slice while collapsed and the whole
// thing only once the reader asks for it.
//
// Two ways to clip. A number clips to that many pixels wherever the body
// sits. "fill" clips to whatever room its flex parent leaves: the caller
// makes the wrapper a flex child (`flex-1`), and the body takes the space
// left after its siblings and fades where that runs out. It is never
// squeezed below `fillFloor` pixels, so a crowded parent shows a few lines
// and a fade rather than a sliver; and the floor never exceeds the content,
// so a short body leaves no empty gap under itself. A fill body cannot open
// in place (its parent is what caps it), so it hands the toggle to
// `onExpand`, which opens the content somewhere with room (the decision
// card grows to the full pane).
export function CollapsibleBody({
  collapsedHeight = 180,
  className = "",
  toggleClassName = "",
  expandLabel = "Expand",
  collapseLabel = "Collapse",
  openOnFocus = false,
  onExpand,
  fillFloor = 88,
  children,
}: {
  collapsedHeight?: number | "fill";
  className?: string;
  toggleClassName?: string;
  /** What the toggle says. Name the content when the reader needs to know
   *  what opens ("Show the description"), not just that something will. */
  expandLabel?: string;
  collapseLabel?: string;
  /** Open when focus enters the body. An editable body (a description, a
   *  form) must not stay clipped around the caret the reader just placed. */
  openOnFocus?: boolean;
  /** The toggle opens the content elsewhere instead of in place. */
  onExpand?: () => void;
  /** Fill mode: the fewest pixels the body keeps when its parent is crowded. */
  fillFloor?: number;
  children: React.ReactNode | ((expanded: boolean) => React.ReactNode);
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fill = collapsedHeight === "fill";
  // The fill floor, capped at the content's own height (see above).
  const [floor, setFloor] = useState(fillFloor);

  // The clip lives on the outer box, so the inner box keeps its natural height
  // and measures the real content. Markdown settles over several frames (fonts,
  // images, code blocks), so the observer — not a dep on `children` — is what
  // catches the final size. Keeping `children` out of the deps also matters in a
  // transcript: it is a fresh object every render, and depending on it would
  // rebuild the observer on every parent re-render, on every mounted card.
  //
  // A fill body measures against the box the flex parent gave it, so the
  // box is observed too: the parent resizing (a pane, a window) is what
  // changes whether the content fits.
  useWatchEffect(() => {
    const el = innerRef.current;
    const box = boxRef.current;
    if (!el || !box) return;
    const limit = () => (collapsedHeight === "fill" ? box.clientHeight : collapsedHeight);
    const measure = () => {
      setOverflows(el.scrollHeight > limit() + 8);
      if (collapsedHeight === "fill") setFloor(Math.min(fillFloor, el.scrollHeight));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (collapsedHeight === "fill") ro.observe(box);
    return () => ro.disconnect();
  }, [collapsedHeight, fillFloor]);

  const clipped = overflows && !expanded;

  return (
    <div className={`${fill ? "flex flex-col" : ""} ${className}`} onFocusCapture={openOnFocus && !expanded ? () => setExpanded(true) : undefined}>
      <div
        ref={boxRef}
        className={fill ? "flex-1 overflow-hidden" : undefined}
        style={{
          ...(fill ? { minHeight: floor } : {}),
          ...(clipped ? { ...(fill ? {} : { maxHeight: collapsedHeight, overflow: "hidden" }), ...clipFade() } : {}),
        }}
      >
        <div ref={innerRef}>{typeof children === "function" ? children(expanded) : children}</div>
      </div>
      {overflows && (
        <button
          onClick={onExpand ?? (() => setExpanded((e) => !e))}
          className={`shrink-0 flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors ${toggleClassName}`}
        >
          {expanded ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
          {expanded ? collapseLabel : expandLabel}
        </button>
      )}
    </div>
  );
}

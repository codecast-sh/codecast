// Floating toolbar that appears when the user selects text inside an assistant
// message body (anything inside a .cc-msg-review region). One action — "Quote
// into reply" — which adds the selection to your reply as a rail card with an
// optional note (same single verb as the per-block hover handle). Positioned at
// the selection rect via a portal.

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createReviewComment } from "../lib/reviewActions";

type Anchor = { x: number; y: number; messageId: string; blockIndex: number; quote: string };

function resolveSelection(): Anchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  const anchorEl = (range.startContainer.nodeType === 1
    ? (range.startContainer as Element)
    : range.startContainer.parentElement) as HTMLElement | null;
  const region = anchorEl?.closest(".cc-msg-review") as HTMLElement | null;
  if (!region) return null; // selection isn't in a reviewable assistant body

  const msgEl = region.closest('[id^="msg-"]') as HTMLElement | null;
  const messageId = msgEl?.id?.slice(4);
  if (!messageId) return null;

  // Which top-level block does the selection start in? Blocks are the direct
  // children of the .cc-content column (the region is a flex row of content|rail).
  const contentEl = region.querySelector(":scope > .cc-content") as HTMLElement | null;
  if (!contentEl) return null;
  let blockEl: HTMLElement | null = anchorEl;
  while (blockEl && blockEl.parentElement !== contentEl) blockEl = blockEl.parentElement;
  const blockIndex = blockEl ? Math.max(0, Array.from(contentEl.children).indexOf(blockEl)) : 0;

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return { x: rect.left + rect.width / 2, y: rect.top, messageId, blockIndex, quote: text };
}

export function SelectionQuoteToolbar({ conversationId }: { conversationId: string }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAnchor(resolveSelection()), 120);
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        if (timer.current) clearTimeout(timer.current);
        setAnchor(null);
      } else {
        schedule();
      }
    };
    const onMouseUp = () => schedule();
    const onScroll = () => setAnchor(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAnchor(null);
    };

    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mouseup", onMouseUp);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  if (!anchor) return null;

  const clear = () => {
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  };
  // Same single verb as the per-block handle: quote the selection into your
  // reply (a rail card) and open an optional note.
  const doQuote = () => {
    createReviewComment(conversationId, anchor.messageId, anchor.blockIndex, anchor.quote);
    clear();
  };

  // Place above the selection; flip below if too close to the top.
  const flipBelow = anchor.y < 56;
  return createPortal(
    <div
      className="cc-sel-toolbar"
      style={{
        left: anchor.x,
        top: flipBelow ? anchor.y + 22 : anchor.y - 8,
        transform: flipBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="cc-sel-btn" onClick={doQuote}>
        ❝ Quote into reply
      </button>
    </div>,
    document.body,
  );
}

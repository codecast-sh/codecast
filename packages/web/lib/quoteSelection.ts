// Resolving a live text selection into a quotable anchor. Shared by the floating
// selection toolbar (mouse path) and the `r` conversation shortcut (keyboard
// path) so both quote the SAME thing the same way — one resolver, one verb.

import { CANVAS_HOST_CLASS, quoteUnitAt } from "./quoteUnits";
import { createReviewComment } from "./reviewActions";

export type QuoteSelection = {
  x: number;
  y: number;
  messageId: string;
  blockIndex: number;
  quote: string;
};

// The selected range, wherever it lives. A canvas draws into a shadow root, and
// the document's Selection reports a selection made inside one as collapsed at
// the host, though its text is there: only getComposedRanges, handed the
// canvases' roots, returns where the words really are. A caret (collapsed, no
// text) returns before any DOM query, since the composer's every keystroke
// lands here.
export function liveSelectionRange(): Range | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  if (!sel.isCollapsed) return sel.getRangeAt(0);
  if (!sel.toString() || typeof sel.getComposedRanges !== "function") return null;
  const shadowRoots = Array.from(document.querySelectorAll(`.cc-msg-review .${CANVAS_HOST_CLASS}`), (h) => h.shadowRoot)
    .filter((r): r is ShadowRoot => !!r);
  if (!shadowRoots.length) return null;
  const composed = sel.getComposedRanges({ shadowRoots })[0];
  const root = composed?.startContainer.getRootNode();
  if (!composed || composed.collapsed || !(root instanceof ShadowRoot) || composed.endContainer.getRootNode() !== root) return null;
  const range = document.createRange();
  range.setStart(composed.startContainer, composed.startOffset);
  range.setEnd(composed.endContainer, composed.endOffset);
  return range;
}

export function resolveQuoteSelection(): QuoteSelection | null {
  const range = liveSelectionRange();
  if (!range) return null;
  // The selection's own text keeps the line breaks between blocks that a
  // range's text drops.
  const text = (window.getSelection()?.toString() || range.toString()).trim();
  if (!text) return null;

  // Inside a canvas, its host stands in for the selection in the transcript.
  const root = range.startContainer.getRootNode();
  const anchorEl = (root instanceof ShadowRoot
    ? root.host
    : range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement) as HTMLElement | null;
  const region = anchorEl?.closest(".cc-msg-review") as HTMLElement | null;
  if (!region) return null; // selection isn't in a reviewable assistant body

  const msgEl = region.closest('[id^="msg-"]') as HTMLElement | null;
  const messageId = msgEl?.id?.slice(4);
  if (!messageId) return null;

  // Which quote unit does the selection start in? Units are the top-level blocks
  // of the .cc-content column, with lists expanded per <li> — see lib/quoteUnits.
  // The hover handle resolves the same way, so selection and hover indices agree.
  const contentEl = region.querySelector(":scope > .cc-content") as HTMLElement | null;
  if (!contentEl) return null;
  const blockIndex = quoteUnitAt(contentEl, anchorEl)?.index ?? 0;

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return { x: rect.left + rect.width / 2, y: rect.top, messageId, blockIndex, quote: text };
}

// Quote whatever is selected into the reply and drop the selection. Returns false
// when nothing quotable is selected, so a caller (the `r` shortcut) can fall back
// to its other behaviour.
export function quoteSelectionIntoReply(conversationId: string): boolean {
  const sel = resolveQuoteSelection();
  if (!sel || !conversationId) return false;
  createReviewComment(conversationId, sel.messageId, sel.blockIndex, sel.quote);
  window.getSelection()?.removeAllRanges();
  return true;
}

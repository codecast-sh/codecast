// Resolving a live text selection into a quotable anchor. Shared by the floating
// selection toolbar (mouse path) and the `r` conversation shortcut (keyboard
// path) so both quote the SAME thing the same way — one resolver, one verb.

import { quoteUnitAt } from "./quoteUnits";
import { createReviewComment } from "./reviewActions";

export type QuoteSelection = {
  x: number;
  y: number;
  messageId: string;
  blockIndex: number;
  quote: string;
};

export function resolveQuoteSelection(): QuoteSelection | null {
  if (typeof window === "undefined") return null;
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

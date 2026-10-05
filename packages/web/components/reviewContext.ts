import React from "react";
import type { PendingComment } from "../lib/quoteFormat";

// Bridges the far-apart composer (MessageInput) and the per-message review UI
// (MessageReview, rendered deep inside the virtualized message list) without
// threading callbacks through every intermediate component. ConversationView
// provides a stable value built from its populateInputRef; MessageReview and the
// selection toolbar consume it. A proposal ledger in the thread reads
// `conversationId` for the batch its answers join and presses `send` to
// deliver them (org-staffing.md S39).
export type ReviewComposer = {
  quote: (text: string) => void; // append a blockquote of `text` to the composer now
  populate?: (text: string, opts?: { append?: boolean }) => void; // put `text` in the composer as the next message
  submit: () => void; // compile the pending-comment batch into the composer
  jumpToComment?: (comment: PendingComment) => void;
  scrollToBlock?: (block: HTMLElement, align: "center" | "nearest") => void;
  /** The conversation whose composer this is: the key of the pending batch. */
  conversationId?: string;
  /** Press the composer's send, as Enter or the button would (the batch rides along even with nothing typed). */
  send?: () => void;
  /** The composer hands its send here on mount and null on unmount; `send` calls what is attached. */
  attachSend?: (send: (() => void) | null) => void;
};

export const ReviewComposerContext = React.createContext<ReviewComposer | null>(null);

export function useReviewComposer(): ReviewComposer | null {
  return React.useContext(ReviewComposerContext);
}

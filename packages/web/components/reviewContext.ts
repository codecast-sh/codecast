import React from "react";

// Bridges the far-apart composer (MessageInput) and the per-message review UI
// (MessageReview, rendered deep inside the virtualized message list) without
// threading callbacks through every intermediate component. ConversationView
// provides a stable value built from its populateInputRef; MessageReview and the
// selection toolbar consume it.
export type ReviewComposer = {
  quote: (text: string) => void; // append a blockquote of `text` to the composer now
  submit: () => void; // compile the pending-comment batch into the composer
};

export const ReviewComposerContext = React.createContext<ReviewComposer | null>(null);

export function useReviewComposer(): ReviewComposer | null {
  return React.useContext(ReviewComposerContext);
}

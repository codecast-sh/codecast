// The batch bar shown above the composer while there are pending inline
// comments — the "finish your review" control. Submitting compiles every quote +
// comment into the composer as the next message; cancelling discards the batch.

import React from "react";
import { useShallow } from "zustand/react/shallow";
import { useInboxStore } from "../store/inboxStore";
import { useReviewComposer } from "./reviewContext";
import { cancelReview } from "../lib/reviewActions";
import { KeyCap } from "./KeyboardShortcutsHelp";

export function ReviewBar({ conversationId }: { conversationId: string }) {
  const composer = useReviewComposer();
  const count = useInboxStore(useShallow((s) => (s.reviewComments[conversationId] ?? []).length));
  const reviewing = useInboxStore((s) => s.reviewMessageId !== null);

  if (!count) return null;

  return (
    <div className="cc-review-bar">
      <span className="cc-review-count">
        <span className="cc-review-dot" />
        {count} comment{count !== 1 ? "s" : ""} pending
        {reviewing && <span className="cc-review-hint"> · arrows to move, c to comment, Esc to leave</span>}
      </span>
      <div className="cc-review-actions">
        <button type="button" className="cc-comment-btn" onClick={() => cancelReview(conversationId)}>
          Cancel
        </button>
        <button type="button" className="cc-comment-btn cc-comment-btn-primary" onClick={() => composer?.submit()}>
          Add to message
          <span className="cc-bar-keys">
            <KeyCap size="xs">⌘</KeyCap>
            <KeyCap size="xs">↵</KeyCap>
          </span>
        </button>
      </div>
    </div>
  );
}

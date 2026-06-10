// The batch tray shown above the composer while there are pending inline quotes /
// comments. It previews what's ATTACHED to your next message — sending (Enter /
// the send button) carries these quotes automatically, no separate step. Each row
// is removable with an ✕; "Edit in input" optionally materializes the batch as
// editable text in the composer; "Clear" discards it.

import React from "react";
import { useShallow } from "zustand/react/shallow";
import { X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useReviewComposer } from "./reviewContext";
import { cancelReview } from "../lib/reviewActions";
import { sortPendingComments } from "../lib/quoteFormat";

export function ReviewBar({ conversationId }: { conversationId: string }) {
  const composer = useReviewComposer();
  const comments = useInboxStore(useShallow((s) => s.reviewComments[conversationId] ?? []));
  const count = comments.length;

  if (!count) return null;
  const items = sortPendingComments(comments);

  return (
    <div className="mx-auto px-4 conv-col w-full">
      <div className="cc-review-tray">
        <div className="cc-review-tray-head">
          <span className="cc-review-tray-title">
            <span className="cc-review-dot" />
            {count} quote{count !== 1 ? "s" : ""}
            <span className="cc-review-tray-sub">attached to your reply</span>
          </span>
          <div className="cc-review-tray-actions">
            <button type="button" className="cc-comment-btn" onClick={() => cancelReview(conversationId)}>
              Clear
            </button>
            <button type="button" className="cc-comment-btn cc-comment-btn-primary" onClick={() => composer?.submit()}>
              Edit in input
            </button>
          </div>
        </div>
        <div className="cc-review-tray-list">
          {items.map((c) => (
            <div key={c.id} className="cc-review-tray-item">
              <div className="cc-review-tray-item-main">
                <div className="cc-review-tray-quote">
                  <span className="cc-comment-quote-mark">❝</span>
                  {(c.quote || "").replace(/\s+/g, " ").trim().slice(0, 140)}
                </div>
                {c.body ? <div className="cc-review-tray-note">{c.body}</div> : null}
              </div>
              <button
                type="button"
                className="cc-review-tray-x"
                title="Remove from message"
                aria-label="Remove this quote"
                onClick={() => useInboxStore.getState().removeReviewComment(conversationId, c.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

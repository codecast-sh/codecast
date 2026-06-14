// The batch tray rendered INSIDE the composer block (above the textarea, like the
// queued-message and pasted-image strips) while there are pending inline quotes /
// comments. It previews what's ATTACHED to your next message — sending (Enter /
// the send button) carries these quotes automatically, even with nothing typed.
// Each row is removable with an ✕; "Edit in input" optionally materializes the
// batch as editable text in the composer; "Clear" discards it.

import React, { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { X, Trash2, PencilLine } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useReviewComposer } from "./reviewContext";
import { cancelReview } from "../lib/reviewActions";
import { sortPendingComments } from "../lib/quoteFormat";

export function ReviewBar({ conversationId }: { conversationId: string }) {
  const composer = useReviewComposer();
  const comments = useInboxStore(useShallow((s) => s.reviewComments[conversationId] ?? []));
  const count = comments.length;

  // Clear discards the whole batch, so it arms on first click ("Discard N?") and
  // only fires on the second; the armed state disarms itself after a beat.
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  if (!count) return null;
  const items = sortPendingComments(comments);

  return (
    <div className="cc-review-tray">
        <div className="cc-review-tray-head">
          <span className="cc-review-tray-title">
            <span className="cc-review-dot" />
            {count} quote{count !== 1 ? "s" : ""}
          </span>
          <div className="cc-review-tray-actions">
            <button
              type="button"
              className={`cc-comment-btn cc-comment-btn-danger ${confirmClear ? "cc-comment-btn-confirm" : ""}`}
              onClick={() => {
                if (confirmClear) cancelReview(conversationId);
                else setConfirmClear(true);
              }}
            >
              <Trash2 size={11} />
              {confirmClear ? `Discard ${count}?` : "Clear"}
            </button>
            <button type="button" className="cc-comment-btn cc-comment-btn-primary" onClick={() => composer?.submit()}>
              <PencilLine size={11} />
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
  );
}

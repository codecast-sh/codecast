// Centralizes the store choreography for the quote/comment review feature so the
// selection toolbar, the per-block review UI, and the review bar all drive the
// same state transitions (DRY). These touch only the ephemeral review state in
// inboxStore plus the composer-injection callback passed in by the caller.

import { useInboxStore } from "../store/inboxStore";
import { toBlockquote, formatPendingComments, sortPendingComments } from "./quoteFormat";

export type PopulateFn = (text: string, opts?: { append?: boolean }) => void;

export function genCommentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `pc_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  }
}

// Create a pending comment anchored to a block (quote = full block) or a
// sub-selection (quote = highlighted text), make its message the review target,
// and open its editor. Returns the new comment id.
export function createReviewComment(
  conversationId: string,
  messageId: string,
  blockIndex: number,
  quote: string,
): string {
  const s = useInboxStore.getState();
  const id = genCommentId();
  s.addReviewComment(conversationId, { id, messageId, blockIndex, quote, body: "", createdAt: Date.now() });
  s.setReviewTarget(messageId, blockIndex);
  s.setReviewEditingId(id);
  return id;
}

// Append a blockquote of `text` straight into the composer (no batch).
export function quoteToComposer(text: string, populate: PopulateFn): void {
  const q = toBlockquote(text);
  if (q) populate(q, { append: true });
}

// Compile the whole batch into the composer and clear review state. Comments with
// neither a body nor a quote are dropped. Returns false if nothing to submit.
export function submitReview(conversationId: string, populate: PopulateFn): boolean {
  const s = useInboxStore.getState();
  const comments = s.getReviewComments(conversationId).filter((c) => c.body.trim() || c.quote.trim());
  const text = formatPendingComments(sortPendingComments(comments));
  if (!text) return false;
  populate(text, { append: true });
  s.clearReviewComments(conversationId);
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
  return true;
}

// Discard the whole batch and leave review mode.
export function cancelReview(conversationId: string): void {
  const s = useInboxStore.getState();
  s.clearReviewComments(conversationId);
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
}

// Leave keyboard/inline review mode but KEEP the pending comments (they stay
// visible as chips and in the review bar).
export function exitReviewMode(): void {
  const s = useInboxStore.getState();
  s.setReviewTarget(null);
  s.setReviewEditingId(null);
}

// Drop an editor that was opened but left empty (so abandoned "new" comments
// don't linger). Returns true if it removed the comment.
export function discardIfEmpty(conversationId: string, id: string): boolean {
  const s = useInboxStore.getState();
  const c = s.getReviewComments(conversationId).find((x) => x.id === id);
  if (c && !c.body.trim()) {
    s.removeReviewComment(conversationId, id);
    return true;
  }
  return false;
}

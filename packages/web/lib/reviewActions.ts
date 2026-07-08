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
  // First click commits a bare quote immediately (no editor) — it shows up as a
  // chip in the rail and a row in the batch tray. The note is optional, added
  // later via "Add note". setReviewTarget keeps keyboard nav anchored to it.
  s.addReviewComment(conversationId, { id, messageId, blockIndex, quote, body: "", createdAt: Date.now() });
  s.setReviewTarget(messageId, blockIndex);
  return id;
}

// Append a blockquote of `text` straight into the composer (no batch).
export function quoteToComposer(text: string, populate: PopulateFn): void {
  const q = toBlockquote(text);
  if (q) populate(q, { append: true });
}

// Compile the pending batch into markdown without touching the composer, and
// clear the batch. The composer's send path calls this to AUTO-ATTACH the quotes
// to the outgoing message — so the user never has to remember a separate "add to
// message" step; a plain send carries the quotes. Returns "" when nothing pending.
//
// Pass `messageId` to take only the comments anchored to one review target (e.g.
// a plan rendered under its own namespaced key) and clear just those, leaving any
// other pending comments untouched.
export function takeReviewBatch(conversationId: string, messageId?: string): string {
  const s = useInboxStore.getState();
  const taken = s
    .getReviewComments(conversationId)
    .filter((c) => (c.body.trim() || c.quote.trim()) && (!messageId || c.messageId === messageId));
  const text = formatPendingComments(sortPendingComments(taken));
  if (!text) return "";
  if (messageId) {
    taken.forEach((c) => s.removeReviewComment(conversationId, c.id));
  } else {
    s.clearReviewComments(conversationId);
    s.setReviewTarget(null);
    s.setReviewEditingId(null);
  }
  return text;
}

// Build the outgoing message: the pending batch (if any) prepended to the typed
// reply, clearing the batch. The composer's send path calls this so a plain send
// carries the quotes. With nothing pending it returns `typed` untouched.
export function attachReviewToMessage(conversationId: string, typed: string): string {
  const batch = takeReviewBatch(conversationId);
  if (!batch) return typed;
  const reply = (typed || "").trim();
  return reply ? `${batch}\n\n${reply}` : batch;
}

// Compile the whole batch into the composer (so it can be edited inline) and clear
// review state. The OPTIONAL "edit in input" action — sending already attaches the
// batch via takeReviewBatch, this just materializes it as editable text first.
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

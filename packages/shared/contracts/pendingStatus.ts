// Single source of truth for the delivery status of a queued (pending) message.
// Mirrors the pending_messages.status union in convex/schema.ts exactly.
//
// "cancelled" is the only user-initiated terminal state — the one way to stop
// the always-on retry loop short of delivery; the daemon's getPendingMessages
// never returns it and the healer never revives it.
//
// PURE isomorphic data — safe to import from the Convex runtime, the daemon, and
// the browser.
export const PENDING_MESSAGE_STATUSES = [
  "pending",
  "injected",
  "delivered",
  "failed",
  "undeliverable",
  "cancelled",
  "held",
] as const;

export type PendingMessageStatus = (typeof PENDING_MESSAGE_STATUSES)[number];

/**
 * The daemon's delivery acks after a transcript sync (DWB-03). The rows this
 * process pasted and the user turns just committed are both in order, so the
 * newest common suffix pairs each pasted row with the transcript line that
 * echoed it, and the server stamps that line's client_id exactly. Older
 * pastes with no echo yet stay injected for healing.
 */
export function pairDeliveryAcks(
  pastedIds: readonly string[],
  transcriptIds: readonly string[],
): { pendingMessageId: string; transcriptMessageId: string }[] {
  const n = Math.min(pastedIds.length, transcriptIds.length);
  return pastedIds.slice(pastedIds.length - n).map((pendingMessageId, i) => ({
    pendingMessageId,
    transcriptMessageId: transcriptIds[transcriptIds.length - n + i]!,
  }));
}

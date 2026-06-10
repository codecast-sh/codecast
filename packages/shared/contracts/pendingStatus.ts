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
] as const;

export type PendingMessageStatus = (typeof PENDING_MESSAGE_STATUSES)[number];

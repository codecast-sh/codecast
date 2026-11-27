// The locks a write's acknowledgement settles: the fields an owners change
// paints (sessionOwnersSlice applySessionOwners: the owners read's facts and
// the inbox row's stamps), and every field a priority control paints
// (prioritiesSlice: a move's places on the owner's other rows, which the
// server computes over rows this window may not hold, and done stamps on the
// server's clock). The acknowledgement (inboxStore settleAckedLocks) marks each
// lock the write planted `acked`, and the first server value applied to that
// field after the ack retires it (store syncProtocol), the exact echo or not:
// the server had the change by then, so its answer is the truth (someone
// else's change at the same moment, a follower's, a leave sent offline). A
// value the store saw before the ack is never put back: a feed that batches
// its pushes can still hold the newer answer. A lock that never hears its
// acknowledgement (a window that closed) is bounded like a triage lock
// (HIDDEN_OVERRIDE_SETTLE_MS; releaseSettledFieldLocks and the owners read's apply).
export const ACK_SETTLED_LOCK_FIELDS: Readonly<Record<string, readonly string[] | "every">> = {
  sessionOwners: ["people_ids", "role", "parent_session", "released_parent", "released_role"],
  // An adopt's parent link and stamp too: the server's adopted_at is its own clock.
  sessions: ["owned_by_me", "implicit_owner", "org_role_id", "owner_session_id", "parent_conversation_id", "adopted_at", "parent_released_at"],
  priorities: "every",
};

/** Whether a pending key (`store:id:field`) names a lock its write's acknowledgement settles. */
export function isAckSettledLockKey(key: string): boolean {
  const storeAt = key.indexOf(":");
  const fieldAt = key.lastIndexOf(":");
  if (storeAt < 0 || fieldAt <= storeAt) return false;
  const fields = ACK_SETTLED_LOCK_FIELDS[key.slice(0, storeAt)];
  return fields === "every" || !!fields?.includes(key.slice(fieldAt + 1));
}

// Pure decision logic for the per-table sync-backlog fields the daemon heartbeat
// writes to the user doc (daemon_pending_sync_messages / _conversations). Extracted
// so the mixed-version-rollout invariant can be regression-tested without a live
// Convex backend.
//
// The invariant: during a rollout, an OLD daemon does not send these fields, so the
// heartbeat args arrive undefined. Coercing undefined → 0 would clobber a real
// backlog written by a newer daemon (or by this same daemon a beat earlier) and the
// web chip would show "syncing 0 messages" while we're actually behind. So these
// fields must be patched ONLY when the daemon actually sent a value; otherwise the
// prior value is left untouched.

export type BacklogPatchArgs = {
  pending_sync_messages?: number;
  pending_sync_conversations?: number;
};

// Returns the partial patch for the two backlog fields: a key is present only when
// the daemon sent it. Absent fields are omitted so ctx.db.patch leaves them as-is.
export function backlogFieldsPatch(args: BacklogPatchArgs): {
  daemon_pending_sync_messages?: number;
  daemon_pending_sync_conversations?: number;
} {
  const patch: {
    daemon_pending_sync_messages?: number;
    daemon_pending_sync_conversations?: number;
  } = {};
  if (args.pending_sync_messages !== undefined) {
    patch.daemon_pending_sync_messages = args.pending_sync_messages;
  }
  if (args.pending_sync_conversations !== undefined) {
    patch.daemon_pending_sync_conversations = args.pending_sync_conversations;
  }
  return patch;
}

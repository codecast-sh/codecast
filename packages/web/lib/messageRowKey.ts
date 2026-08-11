// The React/virtualizer key for a single message row in the conversation
// timeline. It MUST be stable across the optimistic→synced handoff: a user send
// first renders as an optimistic row (`_id` === `_clientId` === the client id),
// then the server echo replaces it (`_id` === the Convex id, `client_id` === the
// same client id). Keying on `_id` flips the key at that handoff, so React
// unmounts the optimistic row and mounts a fresh server row — the virtualizer
// then re-measures it, a one-frame blank. In a brand-new session, where this is
// the only row, that blank reads as the message disappearing for a beat before
// it "syncs in". Keying on the client id (carried by BOTH copies, equal by
// construction) makes the SAME DOM node carry the row through the handoff.
//
// The timeline dedup keeps only one of the two copies present at any instant, so
// this never produces a duplicate key. Messages with no client id (everything
// not sent through the optimistic path) fall back to their stable `_id`.
export function messageRowKey(m: {
  _id: string;
  client_id?: string;
  _clientId?: string;
}): string {
  return m.client_id ?? m._clientId ?? m._id;
}

// Force uniqueness across one timeline's row keys. The client id is SUPPOSED to
// be unique per message, but the delivery-ack path has stamped one pending
// row's client_id onto two transcript messages (the harness's boot
// <task-notification> turn adopted positionally, then the real echo adopted by
// content match). Rows sharing a React/virtualizer key don't reconcile — the
// virtualizer files heights under one slot and React accretes ghost DOM copies
// painted on top of neighboring rows. Those double-stamped pairs exist in
// synced data, so the renderer must survive them: every duplicate after the
// first gets a stable positional suffix. Order-stable input (the timeline is
// timestamp-sorted) makes the suffix stable across renders.
export function uniqueRowKeys(keys: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}~dup${n}`;
  });
}

// Muted threads: the thread roots a member silenced in one channel, held on
// their chat_reads row for that channel. A muted thread stops its chat_reply
// bells and pushes; an @mention inside it still reaches them, and its unread
// badge stays (muting silences bells, never badges).
//
// The server and the client's optimistic write both build the list with this
// function, so the pending lock on the field retires on the server's echo
// instead of disagreeing about order or length.

/** Muted threads kept per channel. The oldest mute drops past this. */
export const MUTED_THREADS_CAP = 200;

export function withThreadMuted(
  list: readonly string[] | undefined,
  rootId: string,
  muted: boolean,
): string[] {
  const rest = (list ?? []).filter((id) => id !== rootId);
  if (!muted) return rest;
  return [...rest, rootId].slice(-MUTED_THREADS_CAP);
}

export function isThreadMuted(list: readonly string[] | undefined, rootId: string | undefined): boolean {
  return !!rootId && !!list?.includes(rootId);
}

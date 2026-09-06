// Session unread, once. The one rule web, mobile and the CLI evaluate, so
// three replicas of the same two numbers cannot disagree.
//
// A read mark (convex session_reads) carries the moment the viewer last
// acknowledged the session while looking at it. Unread means the session has
// moved since:
//
//     acknowledged_at < conversations.updated_at
//
// That comparison is what makes an agent re-reporting the SAME state free: a
// heartbeat or a repeated status never bumps updated_at, so the card stays
// read, while a real new turn does bump it and the card re-lights. It is the
// same "a stamp any later activity silently expires" contract the row's own
// rest verdict already uses (inbox_rest_at, see userRestOf) — chosen so the
// unread model needs no second stamp to keep current.

export type SessionReadMark = {
  acknowledged_at?: number;
  /** The manual gesture: unread whatever the stamps say, until the next ack. */
  manual_unread?: boolean;
};

export type SessionUnreadInput = {
  /** conversations.updated_at — the session's activity watermark. */
  updatedAt: number;
  /** The server read mark, when one has synced. */
  mark?: SessionReadMark | null;
  /** The local "last opened" record (web _lastViewedAt), used only while no
   *  server mark exists. Without it the model's arrival would light up every
   *  session a long-time user has already read, on every client at once. */
  localViewedAt?: number;
};

/** When the viewer last acknowledged the session, server mark or local record. */
export function acknowledgedAt(input: SessionUnreadInput): number {
  return Math.max(input.mark?.acknowledged_at ?? 0, input.localViewedAt ?? 0);
}

export function isSessionUnread(input: SessionUnreadInput): boolean {
  if (input.mark?.manual_unread) return true;
  if (!input.updatedAt) return false;
  return acknowledgedAt(input) < input.updatedAt;
}

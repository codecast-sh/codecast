// Session unread, once. The one rule web, mobile and the CLI evaluate, so
// three replicas of the same numbers cannot disagree.
//
// A read mark (convex session_reads) carries the moment the viewer last
// acknowledged the session while looking at it. Unread means a TURN has landed
// since:
//
//     acknowledged_at < turn_completed_at
//
// `turn_completed_at` (managed_sessions, ct-49533) is the per-turn identity
// every completion consumer dedupes on — it moves when a turn ends and at no
// other time. That is what makes an agent re-reporting the same state free:
// heartbeats, streamed tokens and repeated statuses never move it, so the card
// stays read, while a real new turn moves it and the card re-lights.
//
// Two rows do not carry that stamp: sessions older than the feature, and rows
// whose harness never reported a turn. They fall back to conversations.updated_at,
// which moves on real activity but not on heartbeats or metrics writes — the
// same "a stamp any later activity silently expires" contract the row's own
// rest verdict uses (inbox_rest_at, see userRestOf). Coarser, never wrong in
// the noisy direction.
//
// A SESSION BOUNDARY is the one settle that must never light a card: a resume,
// a clear or a manual compact lands the pane at an idle prompt without a turn
// ending, so there is nothing new to read. `turn_completed_at` already ignores
// it by construction; the guard below covers the fallback rows, where a resume
// does bump updated_at and would otherwise fake an unread.

export type SessionReadMark = {
  acknowledged_at?: number;
  /** The manual gesture: unread whatever the stamps say, until the next ack. */
  manual_unread?: boolean;
};

/** The row facts the read model reads. All optional but `updatedAt`, so a
 *  client running ahead of the backend that supplies them still renders. */
export type SessionActivityFacts = {
  /** conversations.updated_at — the row's activity watermark. */
  updatedAt: number;
  /** managed_sessions.turn_completed_at — when the lead turn behind the
   *  current status ended (ct-49533). Preferred over updatedAt. */
  turnCompletedAt?: number | null;
  /** managed_sessions.agent_status_boundary — the settle came from a resume, a
   *  clear or a manual compact, not from a turn ending (ct-49533). */
  statusBoundary?: boolean | null;
};

export type SessionUnreadInput = SessionActivityFacts & {
  /** The server read mark, when one has synced. */
  mark?: SessionReadMark | null;
  /** The local "last opened" record (web _lastViewedAt), used only while no
   *  server mark exists. Without it the model's arrival would light up every
   *  session a long-time user has already read, on every client at once. */
  localViewedAt?: number;
};

/** The moment the session last did something worth reading — 0 when nothing
 *  did. Also the stamp a client acknowledges, so the two sides of the
 *  comparison are always the same number. */
export function sessionActivityAt(facts: SessionActivityFacts): number {
  const turn = facts.turnCompletedAt ?? 0;
  if (turn > 0) return turn;
  // No turn stamp, so updated_at is all there is — and a boundary settle bumps
  // it without a turn having ended. Report no activity rather than invent one.
  if (facts.statusBoundary) return 0;
  return facts.updatedAt ?? 0;
}

/** When the viewer last acknowledged the session, server mark or local record. */
export function acknowledgedAt(input: SessionUnreadInput): number {
  return Math.max(input.mark?.acknowledged_at ?? 0, input.localViewedAt ?? 0);
}

export function isSessionUnread(input: SessionUnreadInput): boolean {
  if (input.mark?.manual_unread) return true;
  const activityAt = sessionActivityAt(input);
  if (!activityAt) return false;
  return acknowledgedAt(input) < activityAt;
}

// ── The write gate ───────────────────────────────────────────────────────────

export type AckGateInput = {
  conversationId?: string | null;
  /** The session is the view the shell says is current — not a background
   *  pane, not a row merely held in the store. */
  isActiveView: boolean;
  /** The reader is at the screen. Web: window focused, document visible, this
   *  tab pane on screen. Mobile: screen focused in the navigator, app in the
   *  foreground. */
  present: boolean;
  /** The session's activity watermark; nothing to acknowledge without one. */
  updatedAt: number;
};

/** May this client acknowledge the session right now? All four, never mere
 *  mount: a session open behind another tab is not being read, and marking it
 *  read anyway is the one thing an unread model must never do. */
export function shouldAcknowledge(input: AckGateInput): boolean {
  return !!input.conversationId && input.isActiveView && input.present && input.updatedAt > 0;
}

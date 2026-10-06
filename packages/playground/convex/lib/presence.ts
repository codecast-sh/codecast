// Who is in an app right now. A presence row is a lease the page renews with
// a heartbeat; a row older than the stale window is gone even before the
// prune cron deletes it. Heartbeats only write when something a reader shows
// would change, so an idle room costs one write per visitor per seenWriteMs.

export const PRESENCE = {
  /** How often an open page should beat. */
  heartbeatMs: 15_000,
  /** A row not renewed within this is not here. Covers two missed beats. */
  staleMs: 45_000,
  /** A beat renews last_seen at most this often when nothing else changed. */
  seenWriteMs: 10_000,
  /** How long one "I'm typing" keeps the indicator up without another. */
  typingMs: 6_000,
} as const;

export type PresenceFields = { last_seen: number; typing_until: number; viewing_version: number | null };

export function presenceCutoff(now: number): number {
  return now - PRESENCE.staleMs;
}

export function isHere(row: Pick<PresenceFields, "last_seen">, now: number): boolean {
  return row.last_seen > presenceCutoff(now);
}

export function isTyping(row: Pick<PresenceFields, "typing_until">, now: number): boolean {
  return row.typing_until > now;
}

/** The patch a heartbeat should write to an existing row, or null when the
 *  row already says everything (fresh enough, same version in view). */
export function heartbeatPatch(
  row: Pick<PresenceFields, "last_seen" | "viewing_version">,
  viewing: number | null,
  now: number,
): Pick<PresenceFields, "last_seen" | "viewing_version"> | null {
  const stale = now - row.last_seen >= PRESENCE.seenWriteMs;
  return stale || row.viewing_version !== viewing ? { last_seen: now, viewing_version: viewing } : null;
}

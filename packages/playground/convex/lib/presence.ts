// Who is in an app right now. A presence row is a lease the page renews with
// a heartbeat; a row older than the stale window is gone even before the
// prune cron deletes it. A beat writes only when the row would otherwise get
// close to lapsing, or when what it says changed, so in an idle room every
// other beat is free. Typing lives apart from presence (convex/presence.ts),
// so a typing ping never wakes what reads who is here.

export const PRESENCE = {
  /** How often an open page should beat. */
  heartbeatMs: 15_000,
  /** A beat renews last_seen only once the row is this old. */
  seenWriteMs: 30_000,
  /** A row not renewed within this is not here: a renewal at seenWriteMs
   *  survives one late or missed beat after it. */
  staleMs: 60_000,
  /** How long one "I'm typing" keeps the indicator up without another. */
  typingMs: 6_000,
} as const;

export type PresenceFields = { last_seen: number; viewing_version: number | null };

export function presenceCutoff(now: number): number {
  return now - PRESENCE.staleMs;
}

export function isHere(row: Pick<PresenceFields, "last_seen">, now: number): boolean {
  return row.last_seen > presenceCutoff(now);
}

export function isTyping(row: { until: number }, now: number): boolean {
  return row.until > now;
}

/** The patch a heartbeat should write to an existing row, or null when the
 *  row already says everything (fresh enough, same version in view). */
export function heartbeatPatch(row: PresenceFields, viewing: number | null, now: number): PresenceFields | null {
  const due = now - row.last_seen >= PRESENCE.seenWriteMs;
  return due || row.viewing_version !== viewing ? { last_seen: now, viewing_version: viewing } : null;
}

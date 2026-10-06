// Whether a running rep is still moving: its newest event against the clock.
// A row with no lastEventAt (a finished rep, or a product that records no
// events) has no liveness to show.

/**
 * `live` when the newest event is within `stallAfterMs` of `now`, `stalled`
 * past it, null when there is no readable event time.
 */
export function liveness(lastEventAt: string | null | undefined, now: number, stallAfterMs: number): 'live' | 'stalled' | null {
  if (!lastEventAt) return null;
  const at = Date.parse(lastEventAt);
  if (!Number.isFinite(at)) return null;
  return now - at > stallAfterMs ? 'stalled' : 'live';
}

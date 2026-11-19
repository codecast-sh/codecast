// A link that opens a screen with a param (`/tasks?assignee=<id>`) is an
// arrival: apply it once, then take it off the address.
//
// A tab stays mounted, so the param of the last link stays on its route. Left
// there, the same link a second time arrives with an unchanged param, and a
// screen that applies a param "when it changes" does nothing: the person's
// "all open tasks" opened the list unfiltered once the filter had been
// cleared. Consumed, every arrival is a change from nothing.

export type Arrival<T> = {
  /** The param to apply now, or null when there is nothing new. */
  apply: T | null;
  /** What to remember as seen, for the next step. */
  seen: T | null;
  /** Whether the param is still on the address and should be taken off. */
  consume: boolean;
};

export function linkArrival<T>(linked: T | null | undefined, seen: T | null): Arrival<T> {
  const now = linked ?? null;
  return { apply: now !== null && now !== seen ? now : null, seen: now, consume: now !== null };
}

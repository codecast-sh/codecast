// The session header's glance at the rest of the fleet: who else waits on you,
// and how many are working. Pure over the inbox placement, so it is tested
// without React Native.

/** The inbox route's `only` value for the Needs You filter the strip opens. */
export const NEEDS_YOU_FILTER = 'needs-you';

/** Segments drawn before the number alone carries the count. */
export const MAX_SEGMENTS = 5;

interface Row { _id: string; title?: string | null; is_deferred?: boolean }

export interface NeedsInputGlance {
  needs: Array<{ id: string; title: string }>;
  working: number;
  segments: number;
}

/** Who waits on the person: sessions that need input, and those holding an open decision (placement lifts them into `questions`). */
export function waitingOnYou(placed: { needsInput: Row[]; questions?: Row[] }): Row[] {
  const seen = new Set<string>();
  return [...(placed.questions ?? []), ...placed.needsInput].filter((r) => {
    const id = String(r._id);
    if (seen.has(id)) return false;
    seen.add(id);
    return !r.is_deferred;
  });
}

export function needsInputGlance(placed: { needsInput: Row[]; questions?: Row[]; working: Row[] }, currentId: string): NeedsInputGlance {
  const other = (r: Row) => String(r._id) !== currentId && !r.is_deferred;
  // The rows the filtered inbox lists (inbox.tsx onlyNeedsYou), less the
  // session on screen: the strip counts the others.
  const needs = waitingOnYou(placed).filter(other).map((r) => ({ id: String(r._id), title: r.title?.trim() || 'Untitled session' }));
  return { needs, working: placed.working.filter(other).length, segments: Math.min(needs.length, MAX_SEGMENTS) };
}

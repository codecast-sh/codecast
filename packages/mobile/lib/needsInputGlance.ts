// The session header's glance at the rest of the fleet: which other sessions
// wait on you. Pure over the inbox placement, so it is tested without React
// Native.

/** The inbox route's `only` value for the Needs You filter the glance opens. */
export const NEEDS_YOU_FILTER = 'needs-you';

interface Row { _id: string; title?: string | null; is_deferred?: boolean }

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

/** The rows the filtered inbox lists (inbox.tsx onlyNeedsYou), less the session on screen: the header counts the others. */
export function needsInputGlance(placed: { needsInput: Row[]; questions?: Row[] }, currentId: string): Array<{ id: string; title: string }> {
  return waitingOnYou(placed)
    .filter((r) => String(r._id) !== currentId)
    .map((r) => ({ id: String(r._id), title: r.title?.trim() || 'Untitled session' }));
}

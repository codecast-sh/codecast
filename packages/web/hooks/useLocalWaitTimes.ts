import { hasStoredWaitTime, localWaitMoments } from "@codecast/shared/tasks";
import { useCoarseNow } from "./useCoarseNow";

/**
 * Stored text (TG11) with its UTC wait moments rewritten into the viewer's
 * clock, plus the stored spellings for a `title`. One rewriter for every web
 * reader of stored text — the task timeline's graph lines and the comment
 * stream, which carries the system "Unblocked" comment written with an
 * absolute time on purpose — so one screen never spells one moment two ways.
 * `cast task show` does the same for its history lines and its comments alike.
 *
 * `title` names the stored MOMENTS, not the whole text: a tooltip is a place
 * for the thing that changed, and hanging the original body off one gave a
 * long comment naming one moment a tooltip of the entire comment.
 *
 * This hook subscribes to the shared coarse clock, so a caller that renders a
 * list asks `hasStoredWaitTime` first and only mounts a component using it for
 * the rows that name a moment — otherwise a static list re-renders every
 * minute to recompute text that never changes.
 */
export function useLocalWaitTimes(text: string): { text: string; title?: string } {
  const now = useCoarseNow(60_000);
  const { text: local, stored } = localWaitMoments(text, { now });
  return { text: local, title: stored.length && local !== text ? `Written as ${stored.join(" · ")}` : undefined };
}

export { hasStoredWaitTime };

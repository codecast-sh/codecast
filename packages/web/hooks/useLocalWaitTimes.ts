import { localWaitTimes } from "@codecast/shared/tasks";
import { useCoarseNow } from "./useCoarseNow";

/**
 * Stored text (TG11) with its UTC wait moments rewritten into the viewer's
 * clock, plus the stored words for a `title` when the two differ. One
 * rewriter for every web reader of stored text — the task timeline's graph
 * lines and the comment stream, which carries the system "Unblocked" comment
 * written with an absolute time on purpose — so one screen never spells one
 * moment two ways. `cast task show` does the same for its history lines and
 * its comments alike.
 */
export function useLocalWaitTimes(text: string): { text: string; title?: string } {
  const now = useCoarseNow(60_000);
  const local = localWaitTimes(text, { now });
  return { text: local, title: local === text ? undefined : text };
}

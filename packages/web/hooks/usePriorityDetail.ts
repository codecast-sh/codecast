// One priority as its page and its reference card draw it: the feeder of the
// `priorityDetails` collection (convex priorities.show) and the reader that
// lays it over the `priorities` list row (lib/priorityDetail). Both apps mount
// these (the phone's bundle reaches this file, so it imports nothing DOM-only
// and only by relative path).
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityDetail, PriorityRow } from "@codecast/shared/contracts/priorities";
import { isConvexId } from "@codecast/shared/entities";
import { pinDetailRows } from "../lib/detailRows";
import { lookup } from "../lib/liveEntities";
import { detailRowOf, priorityInStore, type PriorityDetailRow, type PriorityView } from "../lib/priorityDetail";
import { noteEvictedRows } from "../store/idbCollectionDiff";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

/** One `show` answer as the store keeps it: only what the list row (if held) lacks. */
function detailRows(d: PriorityDetail | null | undefined): PriorityDetailRow[] | undefined {
  if (!d) return undefined;
  const s = useInboxStore.getState() as any;
  const listed = s.priorities?.[String(d._id)] as PriorityRow | undefined;
  return [detailRowOf(d, listed, s.priorityDetails?.[String(d._id)], Date.now())];
}

const FEED = { select: detailRows };

/** Drops a priority's cached detail, from disk too (a per-window collection: this window writes it). */
function dropDetail(ref: string) {
  const s = useInboxStore.getState() as any;
  const row = lookup(s.priorityDetails, ref) as PriorityDetailRow | undefined;
  if (!row) return;
  noteEvictedRows("priorityDetails", [row._id]);
  s.dropRows("priorityDetails", [row._id]);
}

/**
 * Feeder: one priority (priorities.show) into priorityDetails. `refused`: no
 * such priority the viewer can read (merged, rewritten, no longer listed to
 * them), and its cached detail is dropped so nothing it held paints again. A
 * row keyed by a client id (the render gallery's) was never the server's, so
 * a refusal leaves it.
 */
export function useSyncPriorityDetail(shortId: string | null | undefined) {
  const ref = shortId ? shortId.toLowerCase() : null;
  const feed = useSyncCollection("priorityDetails", api.priorities.show, ref ? { short_id: ref } : "skip", FEED);
  const localOnly = useInboxStore((s) => {
    const row = ref ? (lookup((s as any).priorityDetails, ref) as PriorityDetailRow | undefined) : undefined;
    return !!row && !isConvexId(String(row._id));
  });
  const refused = feed.refused && !localOnly;
  useWatchEffect(() => {
    if (ref && refused) dropDetail(ref);
  }, [ref, refused]);
  return refused === feed.refused ? feed : { ...feed, refused };
}

/** Reader: a priority by `pri-N` or _id, the list row with its detail laid on. A mounted reader holds the detail row against the cap. */
export function usePriorityDetail(ref: string | null | undefined): PriorityView | undefined {
  const view = useInboxStore((s) => (ref ? priorityInStore(s as any, ref) : undefined));
  const id = view?._id ? String(view._id) : undefined;
  useWatchEffect(() => (id ? pinDetailRows("priorityDetails", [id]) : undefined), [id]);
  return view;
}

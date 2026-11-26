// One priority as its page and its reference card draw it: the feeder of the
// `priorityDetails` collection (convex priorities.show) and its reader. Both
// apps mount these (the phone's bundle reaches this file, so it imports
// nothing DOM-only and only by relative path).
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityDetail, PriorityRow } from "@codecast/shared/contracts/priorities";
import { findEntityInStore } from "../lib/liveEntities";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;
const detailRows = (d: PriorityDetail | null | undefined) => (d ? [d] : []);

/** Feeder: one priority (priorities.show) into priorityDetails. `refused`: no such priority the viewer can read. */
export function useSyncPriorityDetail(shortId: string | null | undefined) {
  return useSyncCollection("priorityDetails", api.priorities.show, shortId ? { short_id: shortId.toLowerCase() } : "skip", { select: detailRows });
}

/** Reader: a priority by `pri-N` or _id: its detail row once fed, else the workspace list's row. */
export function usePriorityDetail(ref: string | null | undefined): PriorityDetail | PriorityRow | undefined {
  return useInboxStore((s) => (ref ? findEntityInStore(s, "priority", ref) : undefined)) as PriorityDetail | PriorityRow | undefined;
}

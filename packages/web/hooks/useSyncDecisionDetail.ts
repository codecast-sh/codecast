import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type DecisionDetailItem } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

// The decision document page's per-view feeder (D4): getWithDoc by short id
// ("sd-N") or Convex id, stored under the decision's Convex id so the page
// paints from cache on the next visit. Returns readiness only; the page reads
// the store (useDecisionDetail).
export function useSyncDecisionDetail(ref: string | undefined): { ready: boolean; missing: boolean; error?: Error } {
  const { data, error } = useQueryNoThrow(api.sessionDecisions.getWithDoc, ref ? { decision_id: ref } : "skip");
  const syncTable = useInboxStore((s) => s.syncTable);
  useConvexSync(
    data,
    useCallback(
      (payload: any) => {
        if (!payload?.decision?._id) return;
        const row: DecisionDetailItem = { _id: payload.decision._id, ...payload };
        syncTable("decisionDetails", [row]);
      },
      [syncTable],
    ),
  );
  return { ready: data !== undefined, missing: data === null, error };
}

/** Open decisions whose page context the host keeps cached, newest first; getWithDocMany reads at most this many. */
const OPEN_DETAIL_CAP = 200;

// Every open decision the store lists (the viewer's queue, and the Line's
// decision inbox) as a stable id list: re-subscribes only when one opens or
// closes, never on a field change.
const openIdsByCollection = new WeakMap<object, string>();
const openDecisionIds = (s: ReturnType<typeof useInboxStore.getState>): string => {
  const rows = s.sessionDecisions;
  let key = openIdsByCollection.get(rows);
  if (key === undefined) {
    key = computeOpenIds(rows);
    openIdsByCollection.set(rows, key);
  }
  return key;
};
const computeOpenIds = (rows: ReturnType<typeof useInboxStore.getState>["sessionDecisions"]): string =>
  Object.values(rows)
    .filter((d) => d.status === "pending")
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, OPEN_DETAIL_CAP)
    .map((d) => d._id)
    .sort()
    .join(",");

// The sync host's prefetch (HostFeeders): the page context of every open
// decision the store lists, so a decision opened from the inbox or the Line
// paints its document, facts and ladder from cache at once.
export function useSyncOpenDecisionDetails(): void {
  const key = useInboxStore(openDecisionIds);
  const args = useMemo(() => (key ? { decision_ids: key.split(",") } : "skip"), [key]);
  const { data } = useQueryNoThrow(api.sessionDecisions.getWithDocMany, args as any);
  const syncTable = useInboxStore((s) => s.syncTable);
  useConvexSync(
    data,
    useCallback(
      (payload: any) => {
        if (!Array.isArray(payload) || !payload.length) return;
        const rows: DecisionDetailItem[] = payload.filter((p: any) => p?.decision?._id).map((p: any) => ({ _id: p.decision._id, ...p }));
        syncTable("decisionDetails", rows);
      },
      [syncTable],
    ),
  );
}

// The detail row for a short id or Convex id, from the store.
export function useDecisionDetail(ref: string | undefined): DecisionDetailItem | undefined {
  return useInboxStore((s) => {
    if (!ref) return undefined;
    const direct = s.decisionDetails[ref];
    if (direct) return direct;
    for (const row of Object.values(s.decisionDetails)) {
      if (row.decision.short_id === ref) return row;
    }
    return undefined;
  });
}

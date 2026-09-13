import { useCallback } from "react";
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

import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

// Manual session buckets + per-conversation assignments. Personal scope — no
// workspace args. One subscription feeds both collections.
export function useSyncBuckets() {
  const result = useQuery(api.buckets.webList, {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    syncTable("buckets", data.buckets ?? []);
    syncTable("bucketAssignments", data.assignments ?? []);
  }, [syncTable]));
}

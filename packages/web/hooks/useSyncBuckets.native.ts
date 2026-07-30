import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

// Native twin of useSyncBuckets — the v1 subscription only. Metro resolves
// this file for the mobile app; Vite never sees it. The web version's
// local-first rollout (featureFlags → useLocalView → PrincipalLocalStateProvider)
// must not enter the mobile bundle: import.meta breaks Hermes at parse time,
// and usePrincipalLocalState throws without a provider mobile never mounts.
// When local-first lands a native runtime, port the slice flags here rather
// than re-importing the web chain.
export function useSyncBuckets() {
  const result = useQuery(api.buckets.webList, {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    syncTable("buckets", data.buckets ?? []);
    syncTable("bucketAssignments", data.assignments ?? []);
  }, [syncTable]));
}

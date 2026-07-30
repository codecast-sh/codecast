import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { localFirstSliceMode } from "../store/local-first/featureFlags";
import { bucketsPrincipalView } from "../store/local-first/referenceContracts";
import { useCutoverSpotCheck, useShadowEquivalence } from "../store/local-first/shadowValidation";
import { useConvexSync } from "./useConvexSync";
import { useLocalView } from "./useLocalView";

const api = _api as any;

// Manual session buckets + per-conversation assignments. Personal scope — no
// workspace args. One subscription feeds both collections. The declared
// local-first view rolls out beside it per its slice flag: "shadow"
// materializes the durable v2 view without touching readers; "cutover" makes
// that durable view the store's feed.
export function useSyncBuckets() {
  const mode = localFirstSliceMode("buckets");
  // Standing divergence monitor after cutover (matrix SHD-03).
  const spotCheck = useCutoverSpotCheck(mode === "cutover", "buckets:principal");
  const result = useQuery(
    api.buckets.webList,
    mode !== "cutover" || spotCheck ? {} : "skip",
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    // In cutover the durable view owns the store; a sampled v1 result feeds
    // only the digest comparison below.
    if (mode === "cutover") return;
    syncTable("buckets", data.buckets ?? []);
    syncTable("bucketAssignments", data.assignments ?? []);
  }, [syncTable, mode]));

  const view = useLocalView(bucketsPrincipalView, {}, { enabled: mode !== "off" });
  const viewRows = view.rows;
  useEffect(() => {
    if (mode !== "cutover" || view.status !== "granted") return;
    const values = viewRows.map((row) => row.value);
    // The durable view is COMPLETE for the whole personal catalog, but both
    // registry entries are isDelta (upsert-only), so absent rows — a bucket
    // deleted or an assignment cleared on another device — would otherwise
    // stay in the store and IDB forever (matrix VIEW-02). Prune everything
    // the complete view no longer contains; optimistic pending stubs are
    // protected by applySyncTable itself.
    syncTable("buckets", values.filter((v) => v.kind === "bucket").map((v) => v.row), {
      pruneAbsentScope: () => true,
    });
    syncTable(
      "bucketAssignments",
      values.filter((v) => v.kind === "assignment").map((v) => v.row),
      { pruneAbsentScope: () => true },
    );
  }, [mode, view.status, viewRows, syncTable]);

  // Cutover gate evidence in shadow mode; sampled standing monitor in cutover.
  useShadowEquivalence({
    enabled: mode === "shadow" || spotCheck,
    contractId: bucketsPrincipalView.id,
    viewKey: "buckets:principal",
    authoritative: useMemo(() => result
      ? [
          ...(result.buckets ?? []).map((row: any) => ({ key: `bucket:${row._id}`, value: row })),
          ...(result.assignments ?? []).map((row: any) => ({ key: `assignment:${row._id}`, value: row })),
        ]
      : null, [result]),
    materialized: useMemo(() => view.status === "granted"
      ? viewRows.map((row) => ({ key: row.entityKey, value: (row.value as any).row }))
      : null, [view.status, viewRows]),
  });
}

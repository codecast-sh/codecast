import { useCallback, useEffect } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { localFirstSliceMode } from "../store/local-first/featureFlags";
import { bucketsPrincipalView } from "../store/local-first/referenceContracts";
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
  const result = useQuery(api.buckets.webList, mode !== "cutover" ? {} : "skip");
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    if (!data) return;
    syncTable("buckets", data.buckets ?? []);
    syncTable("bucketAssignments", data.assignments ?? []);
  }, [syncTable]));

  const view = useLocalView(bucketsPrincipalView, {}, { enabled: mode !== "off" });
  const viewRows = view.rows;
  useEffect(() => {
    if (mode !== "cutover" || view.status !== "granted") return;
    const values = viewRows.map((row) => row.value);
    syncTable("buckets", values.filter((v) => v.kind === "bucket").map((v) => v.row));
    syncTable(
      "bucketAssignments",
      values.filter((v) => v.kind === "assignment").map((v) => v.row),
    );
  }, [mode, view.status, viewRows, syncTable]);
}

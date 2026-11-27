// A workspace's Ship runs into the store (workflow_runs.shippingRuns), fanned into two homes: each run on its way to main
// to `shippingRuns`, and who pressed Ship on each recent run (merged ones included) to `shippingShippers`, keyed by
// the run. Each answer is the workspace's whole set, so a cached row of it the answer lacks leaves (dropAbsent, as
// the checkouts feed does). The Deploys page reads both from the store, so a revisit paints Shipping at once.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ShippingRun, ShippingRuns, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { applyCollectionFeed, useFeederError } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { deployScopeArgs, type StrictWorkspaceKey } from "../lib/workspaceScope";

const api = _api as any;

export type ShippingRunRow = ShippingRun & { workspace: string };
export type ShippingShipperRow = ShippingShipper & { _id: string; workspace: string };

/** One shippingRuns answer into its two homes; the workspace's rows the answer lacks leave. A null answer changes nothing. */
export function applyShipping(workspace: StrictWorkspaceKey, d: ShippingRuns | null | undefined): void {
  if (!d) return;
  const ours = (row: { workspace?: string } | undefined) => row?.workspace === workspace;
  applyCollectionFeed("shippingRuns", d.runs.map((r) => ({ ...r, workspace })), undefined, undefined, ours);
  applyCollectionFeed("shippingShippers", d.shippers.map((s) => ({ ...s, _id: s.run_id, workspace })), undefined, undefined, ours);
}

/** Feeder: one workspace's Ship runs and shippers. `error` is a failed read (a backend without the query yet). */
export function useSyncShipping(workspace: StrictWorkspaceKey | null | undefined): { ready: boolean; error: Error | undefined } {
  const authSettled = useServerAuthSettled();
  const { data, error } = useQueryNoThrow(api.workflow_runs.shippingRuns, workspace && authSettled ? deployScopeArgs(workspace) : "skip");
  useFeederError("workflow_runs:shippingRuns", error);
  useConvexSync(
    data,
    useCallback((d: ShippingRuns | null) => { if (workspace) applyShipping(workspace, d); }, [workspace]),
  );
  return { ready: data !== undefined, error };
}

const runSig = (r: ShippingRunRow) => `${r.status}|${r.updated_at}|${r.current_node_id ?? ""}|${r.node_statuses.map((n) => `${n.node_id}:${n.status}`).join(",")}|${r.pr?.number ?? ""}|${r.task_title ?? ""}|${r.spawner_conversation_id ?? ""}:${r.stand_in ? 1 : 0}|${r.gate_node_id ?? ""}|${r.merge?.sha ?? ""}|${r.ci_verdict?.green ?? ""}|${r.review_verdict?.verdict ?? ""}`;
const shipperSig = (s: ShippingShipperRow) => `${s.merged_sha ?? ""}|${s.spawner_conversation_id ?? ""}|${s.user_id ?? ""}|${s.stand_in ? 1 : 0}`;

/**
 * Reader: a workspace's Ship runs and shippers from the store, with the feeder mounted. `shipping` is null only while
 * nothing is stored and the first answer has not come; `error` only when the read failed with nothing stored.
 */
export function useShipping(workspace: StrictWorkspaceKey | null | undefined): { shipping: { runs: ShippingRunRow[]; shippers: ShippingShipperRow[] } | null; error: boolean; live: boolean; failed: boolean } {
  const { ready, error } = useSyncShipping(workspace);
  const runs = useWorkspaceCollection<ShippingRunRow>("shippingRuns", runSig, workspace ?? null);
  const shippers = useWorkspaceCollection<ShippingShipperRow>("shippingShippers", shipperSig, workspace ?? null);
  const stored = runs.length > 0 || shippers.length > 0;
  return useMemo(() => ({
    shipping: ready || stored ? { runs, shippers } : null,
    error: !!error && !stored,
    // This window's own answer has come (the rows are not only what the cache held).
    live: ready,
    // This window's read failed, whatever the cache holds (`error` stays quiet while a cache stands in).
    failed: !ready && !!error,
  }), [ready, stored, runs, shippers, error]);
}

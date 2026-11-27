// Priorities (convex priorities.ts): the feeder and reader of the `priorities`
// collection, and the person's controls with their put-back on a refusal.
// Fed by /priorities and, while the inbox's Priorities view is up, by the
// sync host's feeders (useSyncInboxPriorities).
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { serverErrorText } from "../lib/errorCause";
import { listMeta, listRows, prioritySig, withLiveRanks, type PriorityListMeta, type PriorityRow, type PriorityWrites } from "../lib/priorities";
import { priorityWrites } from "../lib/priorityWrites";
import { resolveInboxViewMode, useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
// Installs sonner as the undo notifier, which raises a check-off's Undo receipt (lib/priorityWrites).
import "../store/undoStack";
import { useSyncCollection } from "./useSyncCollection";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useCoarseNow } from "./useCoarseNow";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "./useWorkspaceCollection";
import type { PriorityList, PriorityMergeProposal } from "@codecast/shared/contracts/priorities";

const api = _api as any;

/** Feeder: the active workspace's priorities, a snapshot of what the viewer can read there. */
export function useSyncPriorities(on = true) {
  const workspace = useActiveWorkspaceKey();
  return useSyncCollection("priorities", api.priorities.list, on && workspace ? { workspace } : "skip", { select: listRows });
}

/**
 * The priorities the inbox's Priorities view sorts by, while that view is up in
 * a workspace with the feature on. Mounted in the sync host's feeders
 * (DashboardLayout HostFeeders), so the host feeds them whether or not its own
 * window draws the inbox panel; followers read the replicated rows.
 */
export function useSyncInboxPriorities() {
  // The view reads as grouped where the feature is off (resolveInboxViewMode).
  useSyncPriorities(useInboxStore((s) => resolveInboxViewMode(s) === "priorities"));
}

/** When the pass runs, read off the same list answer the feeder takes (one subscription: same query, same args). */
export function usePriorityListMeta(): PriorityListMeta {
  const workspace = useActiveWorkspaceKey();
  const settled = useServerAuthSettled();
  const { data } = useQueryNoThrow(api.priorities.list, settled && workspace ? { workspace } : "skip", { remember: true });
  return listMeta(data as PriorityList | null | undefined);
}

const NO_PROPOSALS: PriorityMergeProposal[] = [];

/** The viewer's merge proposals waiting on them in the active workspace, off the same list answer (one subscription). */
export function usePriorityProposals(): PriorityMergeProposal[] {
  const workspace = useActiveWorkspaceKey();
  const settled = useServerAuthSettled();
  const { data } = useQueryNoThrow(api.priorities.list, settled && workspace ? { workspace } : "skip", { remember: true });
  return (data as PriorityList | null | undefined)?.proposals ?? NO_PROPOSALS;
}

/** Reader: the active workspace's priorities, waking on what a row paints, each rank read live from its place. */
export function usePriorities(): PriorityRow[] {
  const rows = useWorkspaceCollection<PriorityRow>("priorities", prioritySig);
  return useMemo(() => withLiveRanks(rows), [rows]);
}

const WRITES = priorityWrites((message) => toast.error(message));

/** The store's priority actions (lib/priorityWrites), each put back when the server refuses it, the reason shown as a toast; a check-off also records its undo. */
export function usePriorityWrites(): PriorityWrites {
  return WRITES;
}

/** A pass reads as running from the press until its rows land, for at most this long. */
const RUN_SHOWN_MS = 5 * 60_000;

/**
 * "Run now": one pass in the active workspace through the store action
 * (priorities.run on the server). It reads as running until the pass's rows
 * land; a refusal says the server's reason and ends it.
 */
export function useRunPriorities(rowCount: number): { running: boolean; run: (() => void) | null } {
  const workspace = useActiveWorkspaceKey();
  const [since, setSince] = useState<number | null>(null);
  const now = useCoarseNow(30_000);
  const run = useCallback(() => {
    if (!workspace) return;
    setSince(Date.now());
    useInboxStore.getState().runPriorities(workspace).catch((e: unknown) => {
      if (!isRefusedDispatchError(e)) return;
      setSince(null);
      toast.error(serverErrorText(e));
    });
  }, [workspace]);
  const running = since != null && rowCount === 0 && Math.max(now, since) - since < RUN_SHOWN_MS;
  return { running, run: workspace ? run : null };
}

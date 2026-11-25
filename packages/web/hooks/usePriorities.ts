// Priorities (convex priorities.ts): the feeder and reader of the `priorities`
// collection, and the person's controls with their put-back on a refusal.
// Mounted by /priorities only: no other surface lists them.
import { useMemo } from "react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { prioritySig, writeOrRestore, type PriorityRow, type PriorityWrites } from "../lib/priorities";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { useSyncCollection } from "./useSyncCollection";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** Feeder: the active workspace's priorities, a snapshot of what the viewer can read there. */
export function useSyncPriorities() {
  const workspace = useActiveWorkspaceKey();
  return useSyncCollection("priorities", api.priorities.list, workspace ? { workspace } : "skip");
}

/** Reader: the active workspace's priorities, waking on what a row paints. */
export function usePriorities(): PriorityRow[] {
  return useWorkspaceCollection<PriorityRow>("priorities", prioritySig);
}

/**
 * The store's priority actions, each put back when the server refuses it: the
 * rows as they were before the press go back through syncTable, as the server
 * still has them, and the reason shows.
 */
export function usePriorityWrites(rows: PriorityRow[]): PriorityWrites {
  return useMemo(() => {
    const run = (write: () => Promise<unknown>) => {
      const before = structuredClone(rows);
      void writeOrRestore(
        write,
        before,
        (prior) => useInboxStore.getState().syncTable("priorities", prior as any, { isDelta: true }),
        (message) => toast.error(message),
        isRefusedDispatchError,
      );
    };
    const st = () => useInboxStore.getState();
    return {
      rank: (id, rank) => run(() => st().rankPriority(id, rank)),
      setStepTier: (id, key, tier) => run(() => st().setPriorityStepTier(id, key, tier)),
      setAside: (id) => run(() => st().setPriorityAside(id)),
      restore: (id) => run(() => st().restorePriority(id)),
    };
  }, [rows]);
}

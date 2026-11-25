// Priorities (convex priorities.ts): the feeder and reader of the `priorities`
// collection, and the person's controls with their put-back on a refusal.
// Mounted by /priorities only: no other surface lists them.
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { serverErrorText } from "../lib/errorCause";
import { listMeta, listRows, prioritySig, writeOrRestore, type PriorityListMeta, type PriorityRow, type PriorityWrites } from "../lib/priorities";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { useSyncCollection } from "./useSyncCollection";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useCoarseNow } from "./useCoarseNow";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "./useWorkspaceCollection";
import type { PriorityList } from "@codecast/shared/contracts/priorities";

const api = _api as any;

/** Feeder: the active workspace's priorities, a snapshot of what the viewer can read there. */
export function useSyncPriorities() {
  const workspace = useActiveWorkspaceKey();
  return useSyncCollection("priorities", api.priorities.list, workspace ? { workspace } : "skip", { select: listRows });
}

/** When the pass runs, read off the same list answer the feeder takes (one subscription: same query, same args). */
export function usePriorityListMeta(): PriorityListMeta {
  const workspace = useActiveWorkspaceKey();
  const settled = useServerAuthSettled();
  const { data } = useQueryNoThrow(api.priorities.list, settled && workspace ? { workspace } : "skip", { remember: true });
  return listMeta(data as PriorityList | null | undefined);
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

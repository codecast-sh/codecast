import { useCallback } from "react";
import { useQuery } from "convex/react";
import { useBootstrapCollection } from "./useBootstrapCollection";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncPlansWithArgs(wsArgs: WorkspaceArgs, statusFilter?: string, includeAll?: boolean) {
  // Bootstrap floor, one-shot per workspace (sync-log-cargo E8); steady-state
  // freshness rides the sync log's cargo. See useBootstrapCollection.
  const { ready } = useBootstrapCollection(
    "plans",
    api.plans.webList,
    wsArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      // include_all lifts webList's default done/abandoned filter — for
      // surfaces that read the whole workspace (orchestration).
      include_all: includeAll || undefined,
      ...wsArgs,
    },
    { liveLoadingScope: "plans" },
  );
  return { ready };
}

export function useSyncPlans(statusFilter?: string) {
  return useSyncPlansWithArgs(useWorkspaceArgs(), statusFilter);
}

/** Seed the store's plans row from a plans.webGet payload, the page joins
 *  stripped (tasks, sessions, doc_content, comments and author are computed
 *  for the page, not row fields) so the persisted row keeps the list's shape.
 *  The plan page mounts no list feeder and updatePlan writes the draft only
 *  when the row exists: without this seed, a deep link's first charter edit
 *  would paint only after the round trip. syncRecord runs the pending filter,
 *  so an edit in flight is kept over the snapshot. Keyed by the row's own
 *  _id, never the URL param (a short id would store a second copy). */
export function ingestPlanDetail(d: any): void {
  if (!d || typeof d._id !== "string") return;
  const { tasks, sessions, doc_content, comments, author, ...row } = d;
  useInboxStore.getState().syncRecord("plans", String(row._id), row);
}

/**
 * Cross-team mention index for plans — see useSyncMentionTasks for context.
 */
export function useSyncMentionPlans() {
  const syncMentionIndex = useInboxStore((s) => s.syncMentionIndex);
  const result = useQuery(api.plans.webMentionList, { workspace: "all" } as any);

  useConvexSync(result, useCallback((data: any) => {
    syncMentionIndex("plans", data?.items ?? []);
  }, [syncMentionIndex]));
}

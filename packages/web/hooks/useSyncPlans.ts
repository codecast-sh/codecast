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

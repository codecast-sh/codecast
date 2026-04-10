import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

const api = _api as any;

/**
 * Fetches ALL tasks for the current workspace (team or personal) into the store.
 * No pagination, no limits — every task is loaded and kept in the store.
 * All filtering happens client-side.
 */
export function useSyncTasks() {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);
  const syncTable = useInboxStore((s) => s.syncTable);

  const stableArgs = !initialized ? "skip" : activeTeamId
    ? { team_id: activeTeamId, workspace: "team" as const }
    : { workspace: "personal" as const };

  const result = useQuery(api.tasks.webList,
    stableArgs === "skip" ? "skip" : {
      ...stableArgs,
      include_derived: true,
    }
  );

  useConvexSync(result, useCallback((data: any) => {
    syncTable("tasks", data.items ?? data);
  }, [syncTable]));

  return { hasMore: false, loadMore: () => {} };
}

export function useSyncTaskDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetTaskDetail,
    id ? { id: id as any } : "skip"
  );
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    if (id && d) syncRecord("tasks", id, d);
  }, [id, syncRecord]));

  return data;
}

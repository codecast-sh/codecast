import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

const api = _api as any;

/**
 * Fetches ALL tasks for the current workspace (team or personal) into the store.
 * No status/project filtering at the query level — the store holds the complete
 * dataset and all filtering happens client-side. This prevents the task list
 * from jumping when navigating sessions or changing filters.
 */
export function useSyncTasks() {
  const [numItems, setNumItems] = useState(5000);
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);
  const syncTable = useInboxStore((s) => s.syncTable);

  // Stable workspace args: team_id only, NO project_path, NO status filter.
  // Everything is fetched once and cached; all filtering is client-side.
  const stableArgs = !initialized ? "skip" : activeTeamId
    ? { team_id: activeTeamId, workspace: "team" as const }
    : { workspace: "personal" as const };

  const result = useQuery(api.tasks.webList,
    stableArgs === "skip" ? "skip" : {
      ...stableArgs,
      include_derived: true,
      limit: numItems,
    }
  );

  useConvexSync(result, useCallback((data: any) => {
    syncTable("tasks", data.items ?? data);
  }, [syncTable]));

  const hasMore = result?.hasMore ?? false;
  const loadMore = useCallback(() => {
    setNumItems(n => n + 2000);
  }, []);

  return { hasMore, loadMore };
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

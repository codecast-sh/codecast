import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

/**
 * Core task sync — fetches ALL tasks for the given workspace into the store.
 * Shared between web and mobile. Filtering happens client-side.
 */
export function useSyncTasksWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);

  const result = useQuery(api.tasks.webList,
    wsArgs === "skip" ? "skip" : {
      ...wsArgs,
      include_derived: true,
    }
  );

  useConvexSync(result, useCallback((data: any) => {
    syncTable("tasks", data.items ?? data);
  }, [syncTable]));

  return { hasMore: false, loadMore: () => {}, ready: result !== undefined };
}

/**
 * Web wrapper — pulls workspace args from clientState.
 */
export function useSyncTasks() {
  return useSyncTasksWithArgs(useWorkspaceArgs());
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

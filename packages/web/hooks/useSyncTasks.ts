import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

/**
 * Core task sync — fetches ALL tasks for the given workspace into the store.
 * Shared between web and mobile. Filtering happens client-side.
 *
 * The live "activeSession" overlay is fetched as a separate small query so
 * that daemon heartbeats (which churn managed_sessions every ~30s) don't
 * invalidate the multi-MB task payload.
 */
export function useSyncTasksWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);

  const tasksResult = useQuery(api.tasks.webList,
    wsArgs === "skip" ? "skip" : {
      ...wsArgs,
      include_derived: true,
    }
  );
  const activeMap = useQuery(api.tasks.webActiveSessions,
    wsArgs === "skip" ? "skip" : {}
  );

  const merged = useMemo(() => {
    if (tasksResult === undefined) return undefined;
    const items = tasksResult.items ?? tasksResult;
    if (!activeMap) return items;
    return items.map((t: any) => ({
      ...t,
      activeSession: activeMap[String(t._id)] ?? null,
    }));
  }, [tasksResult, activeMap]);

  useConvexSync(merged, useCallback((data: any) => {
    syncTable("tasks", data);
  }, [syncTable]));

  return { hasMore: false, loadMore: () => {}, ready: tasksResult !== undefined };
}

/**
 * Web wrapper — pulls workspace args from clientState.
 */
export function useSyncTasks() {
  return useSyncTasksWithArgs(useWorkspaceArgs());
}

/**
 * Cross-team mention index for tasks — pulls a minimal-field snapshot of
 * every task in every team the user belongs to, plus their personal tasks.
 * Lives in `store.mentionIndex.tasks` so it doesn't fight the active-team
 * `store.tasks` collection that page views render.
 */
export function useSyncMentionTasks() {
  const syncMentionIndex = useInboxStore((s) => s.syncMentionIndex);
  const result = useQuery(api.tasks.webMentionList, { workspace: "all" } as any);

  useConvexSync(result, useCallback((data: any) => {
    syncMentionIndex("tasks", data?.items ?? []);
  }, [syncMentionIndex]));
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

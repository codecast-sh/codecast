import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

const api = _api as any;

// How long the delta window can grow before we bump the cursor. Reactive
// ticks within this window don't resubscribe (cheap), but the result set is
// bounded by ~CURSOR_REFRESH_MS of accumulated changes. 30s strikes a
// balance between resub churn and reactive payload size.
const CURSOR_REFRESH_MS = 30_000;

/**
 * Core task sync — pulls tasks for the workspace into the store.
 * Shared between web and mobile. Filtering happens client-side.
 *
 * Uses a delta cursor: the first subscription fetches a full snapshot, then
 * subsequent reactive runs receive only tasks whose `updated_at` exceeds the
 * cursor. The cursor is bumped periodically (CURSOR_REFRESH_MS) so the
 * reactive window stays small without resubscribing on every change.
 *
 * The live "activeSession" overlay is fetched as a separate small query so
 * that daemon heartbeats (which churn managed_sessions every ~30s) don't
 * invalidate the multi-MB task payload.
 */
export function useSyncTasksWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);

  // Reset the cursor whenever workspace args change — switching teams or
  // toggling workspace=all needs a fresh full snapshot.
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const lastSeenCursor = useRef<number | undefined>(undefined);
  const lastWsKey = useRef<string>(wsKey);
  if (lastWsKey.current !== wsKey) {
    lastWsKey.current = wsKey;
    if (cursor !== undefined) setCursor(undefined);
    lastSeenCursor.current = undefined;
  }

  const tasksResult = useQuery(api.tasks.webList,
    wsArgs === "skip" ? "skip" : {
      ...wsArgs,
      include_derived: true,
      ...(cursor !== undefined ? { since: cursor } : {}),
    }
  );
  const activeMap = useQuery(api.tasks.webActiveSessions,
    wsArgs === "skip" ? "skip" : {}
  );

  // Sync tasks WITHOUT the activeSession overlay so daemon heartbeats
  // (which churn activeMap every ~30s) don't re-sync the entire task table.
  const taskData = useMemo(() => {
    if (tasksResult === undefined) return undefined;
    const items: any[] = tasksResult.items ?? tasksResult;
    return { items, isDelta: !!tasksResult.isDelta, cursor: tasksResult.cursor };
  }, [tasksResult]);

  useConvexSync(taskData, useCallback((data: any) => {
    syncTable("tasks", data.items, { isDelta: data.isDelta });
    if (typeof data.cursor === "number") lastSeenCursor.current = data.cursor;
  }, [syncTable]));

  // Active sessions stored separately — lightweight update, no task resync.
  useConvexSync(activeMap, useCallback((data: any) => {
    if (data) useInboxStore.setState({ taskActiveSessions: data });
  }, []));

  // Periodically promote the latest seen cursor. Each promotion triggers a
  // resubscription with the new `since`, which discards already-shipped rows
  // and keeps the reactive payload trimmed.
  useEffect(() => {
    const id = setInterval(() => {
      const next = lastSeenCursor.current;
      if (next !== undefined && next !== cursor) setCursor(next);
    }, CURSOR_REFRESH_MS);
    return () => clearInterval(id);
  }, [cursor]);

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

import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncTasks(statusFilter?: string, triageStatus?: string) {
  const [numItems, setNumItems] = useState(300);
  const workspaceArgs = useWorkspaceArgs();
  const syncTable = useInboxStore((s) => s.syncTable);
  const result = useQuery(api.tasks.webList,
    workspaceArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      ...workspaceArgs,
      limit: numItems,
      ...(triageStatus ? { triage_status: triageStatus } : {}),
      include_derived: true,
    }
  );

  useConvexSync(result, useCallback((data: any) => {
    syncTable("tasks", data.items ?? data);
  }, [syncTable]));

  const hasMore = result?.hasMore ?? false;
  const loadMore = useCallback(() => {
    setNumItems(n => n + 300);
  }, []);

  return { hasMore, loadMore };
}

export function useSyncTaskDetail(id?: string) {
  const isShortId = id?.startsWith("ct-") || id?.startsWith("pl-");
  const queryArgs = id
    ? isShortId ? { short_id: id } : { id }
    : "skip";
  const data = useQuery(api.tasks.webGet, queryArgs as any);
  const syncRecord = useInboxStore((s) => s.syncRecord);

  useConvexSync(data, useCallback((d: any) => {
    if (id && d) syncRecord("tasks", id, d);
  }, [id, syncRecord]));

  return data ?? null;
}

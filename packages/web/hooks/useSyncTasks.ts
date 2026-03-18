import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskDetail } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncTasks(statusFilter?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const tasks = useQuery(api.tasks.webList,
    workspaceArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      ...workspaceArgs,
    }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(tasks, useCallback((data: any) => {
    syncTable("tasks", data as any);
  }, [syncTable]));
}

export function useSyncTaskDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetTaskDetail,
    id ? { id: id as any } : "skip"
  );
  const syncTaskDetail = useInboxStore((s) => s.syncTaskDetail);

  useConvexSync(data, useCallback((d: any) => {
    if (id) syncTaskDetail(id, d as unknown as TaskDetail);
  }, [id, syncTaskDetail]));
}

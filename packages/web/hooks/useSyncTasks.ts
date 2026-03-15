import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskDetail } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

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

  useEffect(() => {
    if (tasks) {
      syncTable("tasks", tasks as any);
    }
  }, [tasks, syncTable]);
}

export function useSyncTaskDetail(id?: string) {
  const data = useQuery(
    api.taskMining.webGetTaskDetail,
    id ? { id: id as any } : "skip"
  );
  const syncTaskDetail = useInboxStore((s) => s.syncTaskDetail);

  useEffect(() => {
    if (data && id) {
      syncTaskDetail(id, data as unknown as TaskDetail);
    }
  }, [data, id, syncTaskDetail]);
}

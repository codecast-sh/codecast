import { useCallback } from "react";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function usePrefetch() {
  const pathname = usePathname();
  const workspaceArgs = useWorkspaceArgs();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnProjectsPage = pathname === "/projects" || pathname?.startsWith("/projects/");

  const skipTasks = isOnTasksPage || isOnProjectsPage || workspaceArgs === "skip";
  const tasks = useQuery(api.tasks.webList, skipTasks ? "skip" : { ...workspaceArgs });
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(tasks, useCallback((data: any) => {
    syncTable("tasks", (data?.items ?? data) as any);
  }, [syncTable]));
}

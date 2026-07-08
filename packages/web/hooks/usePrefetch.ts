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

  // Overlay-only (isDelta): this warms the cache with the most-recent page from
  // the live channel, which is hard-capped server-side (webList MAX_INITIAL=300).
  // A snapshot sync here would treat that capped page as authoritative and PRUNE
  // every other task the reconcile crawl loaded — flushing the store down to 300
  // on every non-tasks page. The full reconcile in useSyncTasks owns pruning.
  useConvexSync(tasks, useCallback((data: any) => {
    syncTable("tasks", (data?.items ?? data) as any, { isDelta: true });
  }, [syncTable]));
}

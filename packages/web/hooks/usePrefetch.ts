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
  const isOnDocsPage = pathname === "/docs" || pathname?.startsWith("/docs/");

  const tasks = useQuery(api.tasks.webList,
    isOnTasksPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const docsResult = useQuery(api.docs.webList,
    isOnDocsPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(tasks, useCallback((data: any) => {
    syncTable("tasks", (data?.items ?? data) as any);
  }, [syncTable]));

  useConvexSync(docsResult, useCallback((data: any) => {
    const { docs, projectPaths } = data as any;
    syncTable("docs", docs as any, { docProjectPaths: projectPaths });
  }, [syncTable]));
}

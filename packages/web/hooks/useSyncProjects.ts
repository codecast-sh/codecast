import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncProjects() {
  const workspaceArgs = useWorkspaceArgs();
  const result = useQuery(api.projects.webList,
    workspaceArgs === "skip" ? "skip" : workspaceArgs
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    syncTable("projects", data as any);
  }, [syncTable]));
}

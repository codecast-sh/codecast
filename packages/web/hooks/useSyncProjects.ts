import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

export function useSyncProjects() {
  const workspaceArgs = useWorkspaceArgs();
  // The projects list is the project switcher: it spans the whole workspace,
  // so pass only the {workspace, team_id} pair — never the active project_path.
  const result = useQuery(api.projects.webList,
    workspaceArgs === "skip" ? "skip" : workspaceStamp(workspaceArgs)
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    syncTable("projects", data as any);
  }, [syncTable]));
}

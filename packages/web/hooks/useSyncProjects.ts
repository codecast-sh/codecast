import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useIsSyncHost } from "./useSyncRole";

const api = _api as any;

export function useSyncProjects() {
  const isSyncHost = useIsSyncHost();
  const workspaceArgs = useWorkspaceArgs();
  // The projects list is the project switcher: it spans the whole workspace,
  // so pass only the {workspace, team_id} pair — never the active project_path.
  // useQueryNoThrow: this mounts inside Sidebar, and the projects list only
  // enriches the rail — a terminal server error must not unmount the sidebar.
  const { data: result } = useQueryNoThrow(api.projects.webList,
    workspaceArgs === "skip" || !isSyncHost ? "skip" : workspaceStamp(workspaceArgs)
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(result, useCallback((data: any) => {
    syncTable("projects", data as any);
  }, [syncTable]));
}

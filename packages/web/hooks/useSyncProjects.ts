import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMemo } from "react";
import { useFeederWorkspace, useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useSyncCollection } from "./useSyncCollection";
import { useBootstrapCollection } from "./useBootstrapCollection";

const api = _api as any;

export function useSyncProjects() {
  const workspaceArgs = useWorkspaceArgs();
  // The projects list is the project switcher: it spans the whole workspace,
  // so pass only the {workspace, team_id} pair — never the active project_path.
  // Bootstrap floor, one-shot per workspace (sync-log-cargo E8); the sync log
  // carries every later change. Host-gated inside the hook. A failed floor
  // only leaves the rail on its cached rows.
  useBootstrapCollection(
    "projects",
    api.projects.webList,
    workspaceArgs === "skip" ? "skip" : workspaceStamp(workspaceArgs),
    { liveLoadingScope: "projects" },
  );
}

/**
 * Per-view feeder: the projects of a workspace that is not the active one (the
 * line app reading the workspace its address names). The active workspace's
 * ride useSyncProjects above; null subscribes nothing.
 */
export function useSyncWorkspaceProjects(workspace: string | null | undefined) {
  const { args } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (!workspace || teamId === "skip" ? "skip" : teamId ? { workspace: "team", team_id: teamId } : { workspace: "personal" }), [workspace, teamId]);
  return useSyncCollection("projects", api.projects.webList, queryArgs as any);
}

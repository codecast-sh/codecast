import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
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

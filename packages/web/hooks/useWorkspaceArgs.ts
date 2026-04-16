import { useInboxStore } from "../store/inboxStore";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

export type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team"; project_path?: string }
  | { workspace: "personal"; project_path?: string }
  | "skip";

export function useWorkspaceArgs(): WorkspaceArgs {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const activeProjectPath = useInboxStore(
    (s) => s.activeProjectPath
  );
  const initialized = useInboxStore((s) => s.clientStateInitialized);

  if (!initialized) return "skip";

  if (activeTeamId) {
    return {
      team_id: activeTeamId,
      workspace: "team" as const,
      ...(activeProjectPath ? { project_path: activeProjectPath } : {}),
    };
  }
  return {
    workspace: "personal" as const,
    ...(activeProjectPath ? { project_path: activeProjectPath } : {}),
  };
}

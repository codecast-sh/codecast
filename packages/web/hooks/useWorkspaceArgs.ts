import { useInboxStore } from "../store/inboxStore";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

export function useWorkspaceArgs(): WorkspaceArgs {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore((s) => s.clientStateInitialized);

  if (!initialized) return "skip";

  if (activeTeamId) {
    return { team_id: activeTeamId, workspace: "team" as const };
  }
  return { workspace: "personal" as const };
}

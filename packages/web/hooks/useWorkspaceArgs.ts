import { useInboxStore, isConvexId } from "../store/inboxStore";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

export type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team"; project_path?: string }
  | { workspace: "personal"; project_path?: string }
  | "skip";

/**
 * The bare {workspace, team_id} pair, without the active project_path.
 * Stamp it onto a created record so it lands in the workspace being viewed
 * (team views are an exact team match — an unstamped record would only show
 * in the personal view), or pass it to workspace-wide queries that must not
 * be scoped to the active project.
 */
export function workspaceStamp(
  args: WorkspaceArgs
): { workspace: "team"; team_id: Id<"teams"> } | { workspace: "personal" } | Record<string, never> {
  if (args === "skip") return {};
  return args.workspace === "team"
    ? { workspace: "team", team_id: args.team_id }
    : { workspace: "personal" };
}

export function useWorkspaceArgs(): WorkspaceArgs {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  // An exclude-mode chip ("everything but this project") must not scope
  // Tasks/Plans/Docs queries — only an include filter expresses "I'm working
  // in this project". Without this guard, excluding a project would narrow
  // those panes to ONLY it, the inverse of the chip.
  const activeProjectPath = useInboxStore(
    (s) => (s.chipFilterExclude ? null : s.activeProjectPath)
  );
  const initialized = useInboxStore((s) => s.clientStateInitialized);

  if (!initialized) return "skip";

  // A just-created team holds an optimistic stub id until the server echoes
  // (inboxStore.createTeam). A stub is not an Id<"teams">; passing it would
  // throw ArgumentValidationError. Skip for the sub-second window instead —
  // the new team has no server rows yet anyway.
  if (activeTeamId && !isConvexId(String(activeTeamId))) return "skip";

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

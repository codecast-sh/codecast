import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

export function useWorkspaceArgs(): WorkspaceArgs {
  const user = useQuery(api.users.getCurrentUser);
  if (!user) return "skip";
  const teamId = (user.active_team_id || user.team_id) as Id<"teams"> | undefined;
  if (teamId) return { team_id: teamId, workspace: "team" };
  return { workspace: "personal" };
}

export function useActiveTeam() {
  const user = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const teamId = (user?.active_team_id || user?.team_id) as Id<"teams"> | undefined;
  const activeTeam = teams?.find((t) => t?._id === teamId);
  const validTeams = (teams?.filter((t: any) => Boolean(t)) ?? []) as NonNullable<NonNullable<typeof teams>[number]>[];
  return { user, teamId, activeTeam, validTeams };
}

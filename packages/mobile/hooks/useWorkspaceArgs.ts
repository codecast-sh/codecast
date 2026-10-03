import { useCallback, useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, isConvexId } from "@codecast/web/store/inboxStore";

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

// The active workspace, read from the store's persisted user record so every
// feeder subscribes on the first frame from cache instead of waiting for
// getCurrentUser to answer. Canonical pointer only: users.active_team_id.
// Unset MEANS the personal workspace; a user not yet known skips.
function useActiveTeamId(): { known: boolean; teamId: Id<"teams"> | undefined } {
  const known = useInboxStore((s) => !!s.currentUser?._id);
  const teamId = useInboxStore((s) => (s.currentUser as any)?.active_team_id) as Id<"teams"> | undefined;
  return { known, teamId };
}

export function useWorkspaceArgs(): WorkspaceArgs {
  const { known, teamId } = useActiveTeamId();
  return useMemo<WorkspaceArgs>(() => {
    if (!known) return "skip";
    // A stub id (a team created this tick) is not an Id<"teams"> yet.
    if (teamId && !isConvexId(String(teamId))) return "skip";
    if (teamId) return { team_id: teamId, workspace: "team" };
    return { workspace: "personal" };
  }, [known, teamId]);
}

export function useActiveTeam() {
  const { teamId } = useActiveTeamId();
  const teams = useInboxStore((s) => s.teams) as any[];
  const validTeams = useMemo(() => (teams ?? []).filter(Boolean), [teams]);
  const activeTeam = useMemo(
    () => validTeams.find((t) => String(t._id) === String(teamId)),
    [validTeams, teamId],
  );
  return { teamId, activeTeam, validTeams };
}

/** Switch the canonical workspace pointer. The optimistic update rewrites the
 *  getCurrentUser answer in this tick; the inbox feeder carries it into
 *  store.currentUser, so every surface re-scopes before the round trip. */
export function useSwitchActiveTeam(): (teamId: Id<"teams"> | null) => void {
  const save = useMutation(api.teams.setActiveTeam).withOptimisticUpdate((local, args) => {
    const user = local.getQuery(api.users.getCurrentUser, {});
    if (user) local.setQuery(api.users.getCurrentUser, {}, { ...user, active_team_id: args.team_id } as any);
  });
  return useCallback((teamId) => { void save({ team_id: teamId ?? undefined }); }, [save]);
}

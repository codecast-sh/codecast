import { useMemo } from "react";
import { useInboxStore } from "@codecast/web/store/inboxStore";

// One workspace pointer on every platform: the store's clientState.ui mirror,
// read by web's useWorkspaceArgs and written (with the canonical
// users.active_team_id) by web's useSwitchWorkspace. Both are persisted, so a
// feeder subscribes on the first frame and a switch re-scopes in the same tick.
export { useWorkspaceArgs } from "@codecast/web/hooks/useWorkspaceArgs";
export { useSwitchWorkspace as useSwitchActiveTeam } from "@codecast/web/hooks/useSwitchWorkspace";

/** The active team id from the mirror; unset is the personal workspace. */
export function useActiveTeamId(): string | undefined {
  return useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined) as string | undefined;
}

export function useActiveTeam() {
  const teamId = useActiveTeamId();
  const teams = useInboxStore((s) => s.teams) as any[];
  const validTeams = useMemo(() => (teams ?? []).filter(Boolean), [teams]);
  const activeTeam = useMemo(
    () => validTeams.find((t) => String(t._id) === String(teamId)),
    [validTeams, teamId],
  );
  return { teamId, activeTeam, validTeams };
}

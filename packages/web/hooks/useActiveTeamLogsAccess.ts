import { parseTeamPolicy } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

/** Whether the active team is one the viewer administers with regulated mode on. */
export function useActiveTeamLogsAccess(): boolean {
  return useInboxStore((s) => {
    const active = s.clientState.ui?.active_team_id;
    const team = active ? s.teams.find((t) => t?._id === active) : null;
    return !!team && team.role === "admin" && parseTeamPolicy((team as any).policy).regulated_data === true;
  });
}

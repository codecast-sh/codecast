// Per-team opt-in features (chat, calls) on mobile. Same contract as web:
// @codecast/shared/contracts/teamFeatures — a feature is off unless the team
// turned it on, and an off feature has no UI. Screens reached by deep link
// (a channel, a thread) ask here before subscribing, because the server
// refuses chat queries for an off team and a thrown query takes the screen
// down with it.
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { teamFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";

/** true/false once the teams list has loaded; undefined while unknown. */
export function useActiveTeamFeature(key: TeamFeatureKey): boolean | undefined {
  const currentUser = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  if (currentUser === undefined || teams === undefined) return undefined;
  const activeTeamId = currentUser?.active_team_id || currentUser?.team_id;
  const team = teams?.find((t: any) => t && String(t._id) === String(activeTeamId));
  return teamFeatureEnabled(team as any, key);
}

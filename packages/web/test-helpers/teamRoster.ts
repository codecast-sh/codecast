import { stampRoster } from "../lib/activeTeam";

/** The team fixtures seed a roster for when the test names none. */
export const FIXTURE_TEAM = "fixture-team";

/**
 * A store fragment holding `members` as the active team's roster, the way
 * useSyncTeamMembers feeds it: each row stamped `roster_team`, and that team
 * active in `clientState.ui`. teamMembersOf reads nothing else, so a roster
 * seeded without both reads empty. Pass the `clientState` to keep (the store's
 * current one, or the fixture's) and it is merged, not replaced.
 */
export function withTeamRoster(members: readonly unknown[], opts: { team?: string; clientState?: any } = {}): { teamMembers: any[]; clientState: any } {
  const team = opts.team ?? FIXTURE_TEAM;
  const cs = opts.clientState ?? {};
  return { teamMembers: stampRoster(members, team), clientState: { ...cs, ui: { ...(cs.ui ?? {}), active_team_id: team } } };
}

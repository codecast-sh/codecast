// The phone's active team: the canonical pointer (users.active_team_id) off the
// store's persisted user record. See activeTeam.ts.
export function activeTeamIdOf(s: any): string | undefined {
  const id = s?.currentUser?.active_team_id;
  return id ? String(id) : undefined;
}

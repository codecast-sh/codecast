// The team the active workspace scopes to: the store's mirror
// (clientState.ui.active_team_id), on every platform. The sanctioned switch
// (hooks/useSwitchWorkspace) writes it and the canonical users.active_team_id
// in the same tick, so a switch re-scopes everything at once. Shared chat and
// call code reads the active team through here. undefined is the personal
// workspace.
export function activeTeamIdOf(s: any): string | undefined {
  const id = s?.clientState?.ui?.active_team_id;
  return id ? String(id) : undefined;
}

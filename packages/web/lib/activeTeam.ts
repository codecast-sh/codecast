// The team the active workspace scopes to, as THIS platform reads it. On web
// that is the window's mirror (clientState.ui.active_team_id): each window
// re-scopes on its own switch without waiting for a round trip, and the
// sanctioned switch (hooks/useSwitchWorkspace) writes the canonical pointer
// beside it. The phone has no windows, so its twin (activeTeam.native.ts)
// reads the canonical pointer itself. Shared chat and call code reads the
// active team through here, so the same hook scopes correctly on both.
// undefined is the personal workspace.
export function activeTeamIdOf(s: any): string | undefined {
  const id = s?.clientState?.ui?.active_team_id;
  return id ? String(id) : undefined;
}

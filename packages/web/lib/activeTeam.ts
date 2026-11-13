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

const NO_MEMBERS: any[] = Object.freeze([]) as unknown as any[];
const rosterCache = new WeakMap<object, Map<string, any[]>>();

/**
 * THE reader of the team roster (`teamMembers`). The store holds one roster,
 * the last team's that was fed, and each row is stamped with the team it came
 * from (`roster_team`, by useSyncTeamMembers). Only the active team's rows are
 * returned: in the personal workspace, and after a switch until the new
 * team's roster lands, it reads empty, never the last team's people. The
 * answer is the store's own array when every row matches (the common case),
 * and stable per (array, team) otherwise, so it is safe as a selector.
 */
export function teamMembersOf(s: any): any[] {
  const team = activeTeamIdOf(s);
  const list = s?.teamMembers as any[] | null | undefined;
  if (!team || !list || list.length === 0) return NO_MEMBERS;
  let perTeam = rosterCache.get(list);
  const hit = perTeam?.get(team);
  if (hit) return hit;
  const mine = list.every((m) => m?.roster_team === team) ? list : list.filter((m) => m?.roster_team === team);
  const out = mine.length ? mine : NO_MEMBERS;
  if (!perTeam) { perTeam = new Map(); rosterCache.set(list, perTeam); }
  perTeam.set(team, out);
  return out;
}

/** Stamp a roster push with the team it answers for (see teamMembersOf). */
export function stampRoster(rows: unknown, team: string): any[] {
  return Array.isArray(rows) ? rows.map((m) => (m && typeof m === "object" ? { ...m, roster_team: team } : m)) : [];
}

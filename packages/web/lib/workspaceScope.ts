// The ONE client-side workspace boundary rule for tasks, plans, and docs.
//
// The store is a single cross-workspace cache: rows from previously-viewed
// workspaces linger (and persist via IDB) until the reconcile crawl catches
// up, so EVERY view over store.tasks / store.plans / store.docs must re-assert
// the active workspace at read time with this predicate. Web and mobile both
// import it — do not inline a variant.
//
// Semantics match the server's list scoping (convex data.ts / lib/access.ts):
// a team space shows ONLY rows tagged to that team; the personal space shows
// ONLY untagged rows. A personal row never follows the user into a team
// space, and one team's rows never appear in another's. Rows shipped by the
// server carry the EFFECTIVE team in team_id (conversation-derived for docs),
// so the raw field is the workspace truth here.

type WorkspaceScoped = { team_id?: string | null };

/** True when the row belongs to the active workspace (team id, or personal when undefined). */
export function inActiveWorkspace(row: WorkspaceScoped, activeTeamId?: string | null): boolean {
  return activeTeamId ? row.team_id === activeTeamId : !row.team_id;
}

/** Filter a store collection down to the active workspace. */
export function filterToWorkspace<T extends WorkspaceScoped>(
  rows: T[],
  activeTeamId?: string | null,
): T[] {
  return rows.filter((r) => inActiveWorkspace(r, activeTeamId));
}

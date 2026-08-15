// The ONE client-side workspace boundary rule for tasks, plans, docs and
// projects.
//
// The store is a single cross-workspace cache: rows from previously-viewed
// workspaces linger (and persist via IDB) until the reconcile crawl catches
// up, so EVERY view over a scoped store collection must re-assert the active
// workspace at read time with this predicate. Web and mobile both import it —
// do not inline a variant.
//
// Rows carry a stored ACCESS key, `workspace` ("team:<id>" | "user:<id>"),
// stamped by the server (convex lib/access.ts) — independent of `team_id`,
// which is ROUTING. The viewer's active workspace is the same shape, built by
// activeWorkspaceKey ONCE from the active-team pointer and the viewer's own
// user id. A read is then a single equality.
//
// Fail closed: an unresolved viewer (no user id yet) has NO workspace key, and
// no row matches a missing key. Personal is a positive value ("user:<me>"),
// never "absence of team" — so it can never act as a wildcard.
//
// Legacy rows (minted before the field existed, or cached in IDB from an older
// client) have no `workspace`; for them the predicate falls back to the raw
// team tag, which the server backfill makes equivalent for un-linked rows.

export type WorkspaceKey = string;

type WorkspaceScoped = { workspace?: string | null; team_id?: string | null };

/**
 * The viewer's active workspace key. Team when the active-team pointer is
 * set, else personal to the VIEWER. Null when the viewer is unknown — the
 * caller must treat null as "nothing matches".
 */
export function activeWorkspaceKey(
  activeTeamId: string | null | undefined,
  viewerUserId: string | null | undefined,
): WorkspaceKey | null {
  if (activeTeamId) return `team:${activeTeamId}`;
  if (viewerUserId) return `user:${viewerUserId}`;
  return null;
}

/** True when the row's access key equals the viewer's active key. */
export function inWorkspace(row: WorkspaceScoped, key: WorkspaceKey | null | undefined): boolean {
  if (!key) return false;
  if (row.workspace) return row.workspace === key;
  // Legacy row without a stored key: the raw tag is the pre-backfill truth.
  return key.startsWith("team:") ? `team:${row.team_id ?? ""}` === key : !row.team_id;
}

/**
 * Transitional predicate keyed on the active team ONLY (personal = no tag).
 * Kept for call sites that have not yet moved to inWorkspace/activeWorkspaceKey;
 * new code must use those. On rows carrying a stored key this stays exact for
 * the team case; for the personal case it cannot know the viewer and admits
 * only key-less/user-keyed rows.
 */
export function inActiveWorkspace(row: WorkspaceScoped, activeTeamId?: string | null): boolean {
  if (activeTeamId) return inWorkspace(row, `team:${activeTeamId}`);
  if (row.workspace) return row.workspace.startsWith("user:");
  return !row.team_id;
}

/** Filter a store collection down to the active workspace key. */
export function filterByWorkspace<T extends WorkspaceScoped>(
  rows: T[],
  key: WorkspaceKey | null | undefined,
): T[] {
  return rows.filter((r) => inWorkspace(r, key));
}

/** Filter a store collection down to the active workspace (transitional). */
export function filterToWorkspace<T extends WorkspaceScoped>(
  rows: T[],
  activeTeamId?: string | null,
): T[] {
  return rows.filter((r) => inActiveWorkspace(r, activeTeamId));
}

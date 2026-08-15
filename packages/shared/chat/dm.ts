// The DM identity key: `<teamId>:<sorted member ids>`.
//
// One implementation because three places compose or parse it — the server's
// openDm (idempotency lookup), the store's optimistic stub (so a stub matches
// the row the server will echo), and the rail's naming (who is the other
// side). Convex ids never contain ":", so the join is unambiguous.

/** Compose the key. `ids` is the FULL member set, viewer included. */
export function dmKeyFor(teamId: string, ids: string[]): string {
  return `${teamId}:${Array.from(new Set(ids.map(String))).sort().join(":")}`;
}

/** The other parties named by a key — everyone but the viewer. */
export function dmOtherIds(dmKey: string | undefined, viewerId: string): string[] {
  if (!dmKey) return [];
  return dmKey
    .split(":")
    .slice(1)
    .filter((id) => id && id !== viewerId);
}

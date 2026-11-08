// The DM identity key: `<teamId>:<sorted member ids>`.
//
// One implementation because three places compose or parse it — the server's
// openDm (idempotency lookup), the store's optimistic stub (so a stub matches
// the row the server will echo), and the rail's naming (who is the other
// side). Convex ids never contain ":", so the join is unambiguous.

/** How many people fit in a DM/group thread — and, since a group thread and
 *  the huddle of its members are the same room, in a people huddle room too
 *  (contracts/callRoomKeys reads this as MAX_ROOM_MEMBERS). One literal for
 *  one rule. */
export const MAX_DM_MEMBERS = 9;

/** Compose the key. `ids` is the FULL member set, viewer included. */
export function dmKeyFor(teamId: string, ids: string[]): string {
  return `${teamId}:${Array.from(new Set(ids.map(String))).sort().join(":")}`;
}

const SESSION_DM_MARK = "#session:";

/** The key of a session's own conversation with the people it named. The
 *  session is a party, so the key never resolves to the room those people
 *  share with the session's owner. */
export function sessionDmKeyFor(teamId: string, ids: string[], conversationId: string): string {
  return `${dmKeyFor(teamId, ids)}${SESSION_DM_MARK}${conversationId}`;
}

/** The id a session stands under among a DM's parties (dmOtherIds). */
export function sessionPartyId(conversationId: string): string {
  return `session:${conversationId}`;
}

export function isSessionPartyId(id: string): boolean {
  return id.startsWith("session:");
}

/** The other parties named by a key — everyone but the viewer. A session's
 *  room names the session among them (sessionPartyId), so no surface takes it
 *  for the viewer's own DM with the people in it. */
export function dmOtherIds(dmKey: string | undefined, viewerId: string): string[] {
  if (!dmKey) return [];
  const [people, session] = dmKey.split(SESSION_DM_MARK);
  const others = people
    .split(":")
    .slice(1)
    .filter((id) => id && id !== viewerId);
  return session ? [...others, sessionPartyId(session)] : others;
}

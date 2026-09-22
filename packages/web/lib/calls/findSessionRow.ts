import { sessionIdentity } from "../sessionIdentity";

// A session row in the store by any of the ids a route target can carry: the
// conversation id, the agent's session id, or the short id. Shared by every
// call surface that names a fed session (the feed chips, the chat rail's
// participants strip) so they cannot disagree about which session a route is.
export function findSessionRow(state: any, ref: string): any | null {
  const direct = state.sessions?.[ref];
  if (direct) return direct;
  const rows = Object.values(state.sessions ?? {}) as any[];
  return (
    rows.find(
      (x) =>
        x &&
        (String(x._id) === ref || String(x.session_id) === ref || String(x.short_id ?? "") === ref),
    ) ?? null
  );
}

/** What a session route is called before its session row has arrived. The
 *  room thread's roster uses the same word, so one missing row has one name. */
export const NEW_AGENT_NAME = "new agent";

/** An agent in the room goes by its character (session-characters.md S1):
 *  the name people say to address it and the name beside its lines. Every
 *  fed session is personified here whether or not anyone opted in elsewhere,
 *  because a room needs a name to call it by; a role's session is the role. */
export function agentRoomName(row: any): string {
  const id = sessionIdentity(row, true);
  return id.kind === "plain" ? row.title || NEW_AGENT_NAME : id.name;
}

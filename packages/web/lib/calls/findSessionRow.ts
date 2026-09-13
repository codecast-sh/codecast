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

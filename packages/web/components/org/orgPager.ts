// Paging rules for a parent's session stack. Pure, so the page's cursor
// arithmetic and its moved-row bookkeeping are testable without React.
import type { OrgSession } from "./orgTypes";

/**
 * The cursor for the next org.sessionsUnder request. The server pages by
 * offset (`cursor` = the number of rows already seen) and the tree payload IS
 * page one, so the first request starts past what the page already holds;
 * later requests continue from the server's own next_cursor.
 */
export function firstServerCursor(saved: string | null | undefined, alreadyLoaded: number): string {
  return saved ?? String(alreadyLoaded);
}

/**
 * Move a session between the page's loaded lists (rows beyond the tree's top
 * N). It leaves every list it was in; it joins the target's list only when
 * that list is open (present), so a closed stack is not forced open by a move.
 */
export function moveExpandedSession(
  expanded: Readonly<Record<string, OrgSession[]>>,
  conversationId: string,
  targetId: string,
  row: OrgSession | null,
): Record<string, OrgSession[]> {
  const out: Record<string, OrgSession[]> = {};
  let changed = false;
  for (const [k, rows] of Object.entries(expanded)) {
    const kept = rows.filter((s) => s._id !== conversationId);
    if (kept.length !== rows.length) changed = true;
    out[k] = kept;
  }
  if (row && targetId in out && !out[targetId].some((s) => s._id === conversationId)) {
    out[targetId] = [...out[targetId], row];
    changed = true;
  }
  return changed ? out : (expanded as Record<string, OrgSession[]>);
}

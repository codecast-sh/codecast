// A card's subagents folded to one entry per state, for the folded line on the
// web rail (components/inbox/SessionCardParts) and the phone inbox. The rows,
// their states and the filter come from the store (subagentRowsOf), so every
// mode on every surface agrees on a subagent's state.
// The phone bundle reaches this file: relative imports only, no DOM or React.
import type { InboxSession, SubagentRow } from "../store/inboxStore";
import type { SessionStatus } from "./sessionStatus";

export type SubagentStateGroup = { status: SessionStatus; count: number; newest: InboxSession };

/** Rows (subagentRowsOf order) folded to one entry per state, in the same
 *  order: how many, and the newest, which the folded line's count opens. */
export function subagentStateGroups(rows: readonly SubagentRow[]): SubagentStateGroup[] {
  const groups: SubagentStateGroup[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.status === r.status);
    if (g) g.count++;
    else groups.push({ status: r.status, count: 1, newest: r.session });
  }
  return groups;
}

/** The rail row that draws a session: its card, or its Compact row under its
 *  parent's card. The rows keep their own attribute rather than a card's
 *  data-session-id, which the rail's card styling keys on (app/globals.css). */
export function railRowSelector(id: string): string {
  return `[data-session-id="${id}"], [data-sv-subagent-row="${id}"]`;
}

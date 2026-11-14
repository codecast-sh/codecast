// Subagents nested under a card (Task subagents and agent-team teammates,
// nestParentIdOf) whose rows the subagent toggle folds away, and that are
// running now: the parent card's count of them, and the newest one, which the
// count opens (the most recently active). The selected row always renders, so it is not counted. The rows stay the detail; the count keeps the work in sight.
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { isAgentActive, type InboxSession } from "../store/inboxStore";

const NONE = { hiddenRunningSubagents: 0, foldedSubagentId: null };

export function foldedRunning(subs: readonly InboxSession[] | undefined, showSubagents: boolean, now: number, shownId?: string | null): { hiddenRunningSubagents: number; foldedSubagentId: string | null } {
  if (showSubagents || !subs?.length) return NONE;
  let count = 0;
  let newest: InboxSession | null = null;
  for (const sub of subs) {
    if (sub._id === shownId || !nestParentIdOf(sub) || !isAgentActive(sub, now)) continue;
    count++;
    if (!newest || (sub.updated_at ?? 0) > (newest.updated_at ?? 0)) newest = sub;
  }
  return count ? { hiddenRunningSubagents: count, foldedSubagentId: newest ? String(newest._id) : null } : NONE;
}

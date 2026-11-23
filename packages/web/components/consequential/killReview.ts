// The one rule for every Kill surface (the card menu, a selection, the
// palette, the phone): a kill ends at once unless it would cut off something
// in flight (shared closeInFlightReason: a turn, a question waiting on you,
// background work, a /loop, a workflow run, a queued start, a limit pick-up),
// cancel an armed trigger or drop queued messages; then it shows this review
// first.
import { closeInFlightReason, type InFlightReason } from "@codecast/shared/contracts";
import type { InboxSession } from "../../store/inboxStore";
import { inFlightFactsOfRow, type CloseRow } from "../../lib/sessionClose";
import { armedInjectTasksFor, taskDisplayTitle, type TaskRow } from "../triggerTasks";
import type { SwitchLedger } from "./ConsequentialSwitch";
import { killSessionsLedger } from "./ledgers";

const titleOf = (s: InboxSession) => (s as { title?: string }).title || "Untitled session";

/** What a kill cuts off, by the reason the session is in flight. A queued
 *  message is the Queued row's, not a cut-off. */
const CUT_OFF: Record<InFlightReason, string | null> = {
  live: "Unfinished turns",
  awaiting: "Questions waiting on you",
  workflow: "Workflow runs",
  background: "Background work",
  fleet: "Queued starts",
  loop: "Running /loops",
  limit: "Pick-ups after a limit",
  queued: null,
};

/** What a kill of this session cuts off, or null. The inbox row's is_idle
 *  false is a live turn too. */
function cutOffOf(s: InboxSession, now: number): string | null {
  const facts = inFlightFactsOfRow(s as CloseRow, now);
  const reason = closeInFlightReason({ ...facts, turnLive: facts.turnLive || s.is_idle === false });
  return reason ? CUT_OFF[reason] : null;
}

/** The review a kill of `sessions` must show, or null when it may end them at
 *  once. A role's own session is not killed (its kill opens the retire
 *  question instead, store undoActions askRetireInstead), so it counts for
 *  nothing here; a persistent anchor's kill is dormancy that keeps its
 *  triggers and queue (convex cleanup.ts), so only what it would cut off counts. */
export function killReviewOf(sessions: InboxSession[], tasks: TaskRow[], now = Date.now()): SwitchLedger | null {
  const killed = sessions.filter((s) => !s.standing_role_id);
  const retiring = killed.filter((s) => !s.persistent);
  const cut = killed.flatMap((s) => { const lost = cutOffOf(s, now); return lost ? [{ s, lost }] : []; });
  const working = cut.map((c) => titleOf(c.s));
  const lost = [...new Set(cut.map((c) => c.lost))];
  const triggers = retiring.flatMap((s) => armedInjectTasksFor(tasks, s._id).map(taskDisplayTitle));
  const queued = retiring.filter((s) => s.has_pending).length;
  if (working.length === 0 && triggers.length === 0 && queued === 0) return null;
  return killSessionsLedger({ total: killed.length, working, lost, triggers, queued, ...(killed.length === 1 ? { subject: titleOf(killed[0]!) } : {}) });
}

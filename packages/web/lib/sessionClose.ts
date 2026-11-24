// The facts a card's Close reads for one session, from the rows the client
// holds. The decision and its words are shared (contracts/closeKind), so every
// Close surface (the card button, session.close, the menu, the phone) and
// close advice say what the gesture does. Close is dormancy, not retirement: a
// session in flight (shared closeInFlightReason), or the lead of a nested group
// any member of which a close would take down is, is set aside instead of
// stopped. A close takes down only its Task subagents and teammates (shared
// cascadeTakesDownRow); a spawned child with its own process stays up. The
// server gathers the same facts from its database (convex lib/closeAside).
// Imports by relative path only: the phone bundles this file (Metro maps `@/`
// to mobile).
import { closeInFlightReason, isLoopFresh, openTasksVouchForWaiting, rowHeartbeatAliveAt, type InFlightFacts, type LoopState } from "@codecast/shared/contracts";
import { cascadeTakesDownRow, type HoldFacts } from "@codecast/shared/contracts/closeCascade";
import { closeFactsFrom, closeInFlightOf, nestedInFlightFrom, type CloseFacts, type NestedInFlight } from "@codecast/shared/contracts/closeKind";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { sessionLiveAt } from "./liveness";

/** The row fields the facts read. Every inbox row carries them. */
export type CloseRow = Parameters<typeof sessionLiveAt>[0] & {
  awaiting_input?: boolean | null;
  persistent?: boolean | null;
  standing_role_id?: string | null;
  armed_trigger_kind?: string | null;
  loop_state?: Pick<LoopState, "status" | "wakeup_at" | "fired_at" | "event_at"> | null;
  workflow_run_id?: string | null;
  workflow_run_status?: string | null;
  workflow_run_kind?: string | null;
  is_workflow_sub?: boolean | null;
  is_workflow_primary?: boolean;
  session_id?: string | null;
  pending_api_error?: boolean | null;
  pending_api_error_kind?: string | null;
  pending_api_error_at?: number | null;
  subagent_slot?: string | null;
  parked_wake_kind?: string | null;
};

const runLiveOf = (row: CloseRow) =>
  !!row.workflow_run_id && !row.is_workflow_sub && (row.workflow_run_status === "running" || row.workflow_run_status === "pending");

/** The shared in-flight facts of one row at `now`, from what the row carries.
 *  `pendingSend`: a send this window has not seen land (a queued message). */
export function inFlightFactsOfRow(row: CloseRow, now: number, pendingSend = false): InFlightFacts {
  return {
    queued: pendingSend || !!row.has_pending,
    loopFresh: !!row.loop_state && isLoopFresh(row.loop_state, now),
    // A Workflow-tool run executes inside this session's agent process.
    inProcessRun: runLiveOf(row) && row.workflow_run_kind === "workflow",
    turnLive: sessionLiveAt(row, now),
    awaitingInput: !!row.awaiting_input,
    openBackgroundWork: openTasksVouchForWaiting(row.open_tasks_at, row.open_tasks?.length ?? 0, rowHeartbeatAliveAt(row, now)),
    fleetQueued: row.subagent_slot === "queued",
    // The pre-close row: a close is the dismissal isBlockedConversation would exclude.
    limitParked: isBlockedConversation({
      pending_api_error: row.pending_api_error === true,
      pending_api_error_kind: row.pending_api_error_kind,
      agent_type: row.agent_type ?? undefined,
      is_workflow_primary: row.is_workflow_primary,
      session_id: row.session_id,
    }) && isCurrentBlock(row, now),
  };
}

/** What a child its lead's close leaves up still holds (shared HoldFacts),
 *  from the row: its in-flight facts, a live heartbeat, an armed trigger. The
 *  server gathers the same from its database (convex lib/closeAside holdFactsOnServer). */
export function holdFactsOfRow(row: CloseRow, now: number): HoldFacts {
  return {
    ...inFlightFactsOfRow(row, now),
    processAlive: rowHeartbeatAliveAt(row, now),
    triggerArmed: (row.armed_trigger_kind ?? "none") !== "none",
  };
}

type NestedRow = CloseRow & Parameters<typeof nestParentIdOf>[0];

/** The members of the nested group under `id` (nestParentIdOf) that a close
 *  of it takes down: its Task subagents and teammates, not already
 *  closed or killed. The same rule store closeInDraft stamps by and the
 *  server's cascade and aside scan read (shared cascadeTakesDownRow). */
export function closeTakesDownOf(rows: Iterable<NestedRow>, id: string): NestedRow[] {
  const out: NestedRow[] = [];
  for (const r of rows) {
    if (nestParentIdOf(r) === id && cascadeTakesDownRow(r as any, "inbox_dismissed_at", { forceKill: true, close: true, queued: !!r.has_pending })) out.push(r);
  }
  return out;
}

/** Whether a member a close of `id` would take down (closeTakesDownOf) is in
 *  flight by the same verdict, and whether one waits on the person, which
 *  outranks the rest. A spawned child mid-turn is not: the close leaves it up. */
export function nestedInFlightOf(rows: Iterable<NestedRow>, id: string, now: number): NestedInFlight {
  let out: NestedInFlight = null;
  for (const r of closeTakesDownOf(rows, id)) {
    out = nestedInFlightFrom(closeInFlightReason(inFlightFactsOfRow(r, now))) ?? out;
    if (out === "nested_awaiting") break;
  }
  return out;
}

/** The facts of one row at `now`. `armedTriggers` is the roster's count of
 *  armed triggers into it; `pendingSend` a send this window has not seen
 *  land; `nested` its nested group in flight (nestedInFlightOf); `takesDown`
 *  how many members a stop takes down (closeTakesDownOf). */
export function closeFactsOf(row: CloseRow, armedTriggers: number, now: number, pendingSend = false, nested: NestedInFlight = null, takesDown = 0): CloseFacts {
  const facts = inFlightFactsOfRow(row, now, pendingSend);
  return closeFactsFrom(row, {
    inFlight: closeInFlightOf(closeInFlightReason(facts), nested),
    armedTriggers,
    lastHeartbeat: row.last_heartbeat ?? null,
    runLive: runLiveOf(row),
    inProcessRun: facts.inProcessRun,
    takesDown,
  }, now);
}

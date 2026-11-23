// What a card's Close does to one session, and the words its tooltip says.
// One decision for every Close surface (the card button, session.close, the
// menu, the phone), so the button never promises what the gesture does not do.
// Close is dormancy, not retirement: a session in flight (shared
// closeInFlightReason), or the lead of a nested group any member of which is,
// is set aside instead of stopped. This file only gathers the facts from the
// rows the client holds; the server gathers the same facts from its database
// (convex lib/closeAside) and asks the same function. Imports by relative path
// only: the phone bundles this file (Metro maps `@/` to the mobile package).
import { closeInFlightReason, isLoopFresh, type InFlightFacts, type InFlightReason, type LoopState } from "@codecast/shared/contracts";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { sessionLiveAt } from "./liveness";

export type CloseFacts = {
  /** Why it is in flight, itself ("nested": a member of its nested group), or null. */
  inFlight: InFlightReason | "nested" | null;
  /** A role's own session or a standing anchor. */
  role: boolean;
  /** Armed triggers that inject into it. */
  triggers: number;
  /** A codecast flow run it started, with station sessions of its own, that
   *  has not reported yet. */
  waitingOnRun: boolean;
};

export type CloseKind = "aside" | "keeps_loop" | "keeps_limit" | "keeps_triggers" | "waits_on_run" | "clears";

export function closeKindOf(f: CloseFacts): CloseKind {
  if (f.inFlight === "loop") return "keeps_loop";
  if (f.inFlight === "limit") return "keeps_limit";
  if (f.inFlight) return "aside";
  if (f.role || f.triggers > 0) return "keeps_triggers";
  if (f.waitingOnRun) return "waits_on_run";
  return "clears";
}

/** Close sets it aside (the agent keeps running) instead of stopping it. */
export const closeSetsAside = (f: CloseFacts) => f.inFlight !== null;

export function closeTooltip(f: CloseFacts): string {
  switch (closeKindOf(f)) {
    case "aside": return "Close: hides it, lets it finish";
    case "keeps_loop": return "Close: hides it, keeps its loop running";
    case "keeps_limit": return "Close: hides it, picks up when its limit resets";
    case "keeps_triggers":
      if (f.triggers === 0) return "Close: stops it, comes back on its next message";
      return `Close: stops it, keeps its ${f.triggers === 1 ? "trigger, comes back when it fires" : `${f.triggers} triggers, comes back when one fires`}`;
    case "waits_on_run": return "Close: stops it, comes back when its run reports";
    case "clears": return "Close: stops it, clears it from the list";
  }
}

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

type NestedRow = CloseRow & Parameters<typeof nestParentIdOf>[0];

/** A member of the nested group under `id` (a Task subagent or a teammate:
 *  the group a close or kill takes down with its lead, nestParentIdOf) is in
 *  flight by the same verdict. */
export function nestedInFlightOf(rows: Iterable<NestedRow>, id: string, now: number): boolean {
  for (const r of rows) if (nestParentIdOf(r) === id && closeInFlightReason(inFlightFactsOfRow(r, now)) !== null) return true;
  return false;
}

/** The facts of one row at `now`. `armedTriggers` is the roster's count of
 *  armed triggers into it; `pendingSend` a send this window has not seen
 *  land; `nestedInFlight` a member of its nested group in flight (nestedInFlightOf). */
export function closeFactsOf(row: CloseRow, armedTriggers: number, now: number, pendingSend = false, nestedInFlight = false): CloseFacts {
  // The row says a trigger is armed before the roster has loaded it.
  const rowArmed = (row.armed_trigger_kind ?? "none") !== "none" ? 1 : 0;
  const facts = inFlightFactsOfRow(row, now, pendingSend);
  return {
    inFlight: closeInFlightReason(facts) ?? (nestedInFlight ? "nested" : null),
    role: !!row.persistent || !!row.standing_role_id,
    triggers: Math.max(armedTriggers, rowArmed),
    waitingOnRun: runLiveOf(row) && !facts.inProcessRun,
  };
}

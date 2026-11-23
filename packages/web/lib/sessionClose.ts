// What a card's Close does to one session, and the words its tooltip says.
// One decision for every Close surface (the card button, session.close, the
// menu, the phone), so the button never promises what the gesture does not do.
// Close is dormancy, not retirement: anything in flight inside the agent's own
// process (a turn, a question, a queued message, a /loop, a Workflow-tool run,
// a busy nested session) sets it aside instead of stopping it. The server
// rechecks the same facts (convex lib/closeAside). Imports by relative path
// only: the phone bundles this file (Metro maps `@/` to the mobile package).
import { isLoopFresh, type LoopState } from "@codecast/shared/contracts";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { sessionLiveAt } from "./liveness";

export type CloseFacts = {
  /** Work in flight in its own process, or in a session nested under it:
   *  Close sets it aside and lets it finish, so nothing in its group stops. */
  running: boolean;
  /** An armed /loop: a wakeup inside the agent process, so Close sets it aside. */
  loop: boolean;
  /** Parked on a usage limit: the reset or an account switch continues it. */
  limit: boolean;
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
  if (f.running) return "aside";
  if (f.loop) return "keeps_loop";
  if (f.limit) return "keeps_limit";
  if (f.role || f.triggers > 0) return "keeps_triggers";
  if (f.waitingOnRun) return "waits_on_run";
  return "clears";
}

/** Close sets it aside (the agent keeps running) instead of stopping it. */
export const closeSetsAside = (f: CloseFacts) => {
  const kind = closeKindOf(f);
  return kind === "aside" || kind === "keeps_loop" || kind === "keeps_limit";
};

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

type InFlightRow = Parameters<typeof sessionLiveAt>[0] & { awaiting_input?: boolean | null };

/** The row fields the facts read. Every inbox row carries them. */
export type CloseRow = InFlightRow & {
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

/** Mid-turn at `now`: producing, or blocked on a question it asked (an open
 *  poll or a permission prompt), which stopping it would lose just the same. */
const turnInFlightAt = (row: InFlightRow, now: number) => sessionLiveAt(row, now) || !!row.awaiting_input;

type NestedRow = InFlightRow & Parameters<typeof nestParentIdOf>[0];

/** A session nested under `id` (a Task subagent or a teammate: the group a
 *  close or kill takes down with its lead, nestParentIdOf) is mid-turn. */
export function nestedRunningOf(rows: Iterable<NestedRow>, id: string, now: number): boolean {
  for (const r of rows) if (nestParentIdOf(r) === id && turnInFlightAt(r, now)) return true;
  return false;
}

/** The facts of one row at `now`. `armedTriggers` is the roster's count of
 *  armed triggers into it; `pendingSend` a send this window has not seen
 *  land, which is a turn starting; `nestedRunning` a session in its nested
 *  group mid-turn (nestedRunningOf). */
export function closeFactsOf(row: CloseRow, armedTriggers: number, now: number, pendingSend = false, nestedRunning = false): CloseFacts {
  // The row says a trigger is armed before the roster has loaded it.
  const rowArmed = (row.armed_trigger_kind ?? "none") !== "none" ? 1 : 0;
  const runLive = !!row.workflow_run_id && !row.is_workflow_sub && (row.workflow_run_status === "running" || row.workflow_run_status === "pending");
  // A Workflow-tool run executes inside this session's agent process.
  const inProcessRun = runLive && row.workflow_run_kind === "workflow";
  return {
    running: pendingSend || nestedRunning || !!row.has_pending || inProcessRun || turnInFlightAt(row, now),
    loop: !!row.loop_state && isLoopFresh(row.loop_state, now),
    // The pre-close row: a close is the dismissal isBlockedConversation would exclude.
    limit: isBlockedConversation({
      pending_api_error: row.pending_api_error === true,
      pending_api_error_kind: row.pending_api_error_kind,
      agent_type: row.agent_type ?? undefined,
      is_workflow_primary: row.is_workflow_primary,
      session_id: row.session_id,
    }) && isCurrentBlock(row, now),
    role: !!row.persistent || !!row.standing_role_id,
    triggers: Math.max(armedTriggers, rowArmed),
    waitingOnRun: runLive && !inProcessRun,
  };
}

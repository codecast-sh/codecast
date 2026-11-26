// What a card's Close does to one session, and the words its tooltip says.
// One decision for every Close surface (the card button, session.close, the
// menu, the phone), so the button never promises what the gesture does not do.
// Close is dormancy, not retirement: a session in flight (shared
// closeInFlightReason), or the lead of a nested group any member of which a
// close would take down is, is set aside instead of stopped. A close takes down
// only its Task subagents and teammates (shared cascadeTakesDownRow); a
// spawned child with its own process stays up. This file only gathers the facts from the
// rows the client holds; the server gathers the same facts from its database
// (convex lib/closeAside) and asks the same function. Imports by relative path
// only: the phone bundles this file (Metro maps `@/` to the mobile package).
import { closeReturnsOnDone, closeInFlightReason, isLoopFresh, openTasksVouchForWaiting, rowHeartbeatAliveAt, type InFlightFacts, type InFlightReason, type LoopState } from "@codecast/shared/contracts";
import { cascadeTakesDownRow, type HoldFacts } from "@codecast/shared/contracts/closeCascade";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { sessionLiveAt } from "./liveness";

export type CloseFacts = {
  /** Why it is in flight, itself ("nested": a member of its nested group), or null. */
  inFlight: InFlightReason | "nested" | null;
  /** A role's own session or a standing anchor. */
  role: boolean;
  /** A closed session stays out through machine wakes and comes back when its
   *  agent pins blocked (Needs you); an ordinary one also when it pins done
   *  (shared closeReturnsOnDone), a role, an anchor or a standing trigger's home not. */
  returnsOnDone: boolean;
  /** Armed triggers that inject into it. */
  triggers: number;
  /** A codecast flow run it started, with station sessions of its own, that
   *  has not reported yet. */
  waitingOnRun: boolean;
  /** Agents under it a stop takes down with it (closeTakesDownOf): its Task
   *  subagents and teammates. */
  takesDown: number;
};

export type CloseKind = "aside" | "awaiting" | "keeps_background" | "keeps_loop" | "keeps_limit" | "keeps_triggers" | "waits_on_run" | "clears";

export function closeKindOf(f: CloseFacts): CloseKind {
  if (f.inFlight === "awaiting") return "awaiting";
  if (f.inFlight === "background") return "keeps_background";
  if (f.inFlight === "loop") return "keeps_loop";
  if (f.inFlight === "limit") return "keeps_limit";
  if (f.inFlight) return "aside";
  if (f.role || f.triggers > 0) return "keeps_triggers";
  if (f.waitingOnRun) return "waits_on_run";
  return "clears";
}

/** Close sets it aside (the agent keeps running) instead of stopping it. */
export const closeSetsAside = (f: CloseFacts) => f.inFlight !== null;

// What brings a closed session back: its agent pinning done (an ordinary
// session) or blocked (isClosedHidden, performSetThreadState), or a person
// writing to it.
const closedBack = (returnsOnDone: boolean) => (returnsOnDone ? "back when it reports done or needs you" : "back when it needs you");

/** The words a closed session a machine woke shows for what brings it back. */
export const closedBackWords = (row: Parameters<typeof closeReturnsOnDone>[0]) => closedBack(closeReturnsOnDone(row));

export function closeTooltip(f: CloseFacts): string {
  const them = f.takesDown === 0 ? "it" : f.takesDown === 1 ? "it and the agent under it" : `it and the ${f.takesDown} agents under it`;
  const back = closedBack(f.returnsOnDone);
  switch (closeKindOf(f)) {
    case "aside": return `Close: hides it, ${back}`;
    case "awaiting": return "Close: hides it; it still waits on you";
    case "keeps_background": return `Close: hides it, keeps its background work, ${back}`;
    case "keeps_loop": return `Close: hides it, keeps its loop, ${back}`;
    // Its resume (a "continue" send, when recovery is on) is an ordinary send
    // and shows it; with recovery off, it waits for the person.
    case "keeps_limit": return "Close: hides it, still parked on its limit";
    case "keeps_triggers":
      if (f.triggers === 0) return `Close: stops ${them}, ${back}`;
      return `Close: stops ${them}, runs its ${f.triggers === 1 ? "trigger" : `${f.triggers} triggers`} out of sight, ${back}`;
    case "waits_on_run": return `Close: stops ${them}, its run goes on, ${back}`;
    case "clears": return `Close: stops ${them}, clears ${f.takesDown ? "them" : "it"} from the list`;
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
  subagent_slot?: string | null;
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

/** A member a close of `id` would take down (closeTakesDownOf) is in flight
 *  by the same verdict. A spawned child mid-turn is not: the close leaves it up. */
export function nestedInFlightOf(rows: Iterable<NestedRow>, id: string, now: number): boolean {
  return closeTakesDownOf(rows, id).some((r) => closeInFlightReason(inFlightFactsOfRow(r, now)) !== null);
}

/** The facts of one row at `now`. `armedTriggers` is the roster's count of
 *  armed triggers into it; `pendingSend` a send this window has not seen
 *  land; `nestedInFlight` a member of its nested group in flight (nestedInFlightOf);
 *  `takesDown` how many members a stop takes down (closeTakesDownOf). */
export function closeFactsOf(row: CloseRow, armedTriggers: number, now: number, pendingSend = false, nestedInFlight = false, takesDown = 0): CloseFacts {
  // The row says a trigger is armed before the roster has loaded it.
  const rowArmed = (row.armed_trigger_kind ?? "none") !== "none" ? 1 : 0;
  const facts = inFlightFactsOfRow(row, now, pendingSend);
  return {
    inFlight: closeInFlightReason(facts) ?? (nestedInFlight ? "nested" : null),
    role: !!row.persistent || !!row.standing_role_id,
    returnsOnDone: closeReturnsOnDone(row),
    triggers: Math.max(armedTriggers, rowArmed),
    waitingOnRun: runLiveOf(row) && !facts.inProcessRun,
    takesDown,
  };
}

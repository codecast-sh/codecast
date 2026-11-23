import { isOrphanOrSubagent } from "./inboxMembership";
// A CLOSED session: the person's Close (web/phone), which stops an agent that
// has nothing in flight without retiring it. Close writes inbox_closed_at equal
// to the inbox_dismissed_at it stamps, and nothing else. The equality is the
// marker: every un-hide clears inbox_dismissed_at and every other dismissal
// writes a new stamp, so neither needs to know this field exists, and a stale
// inbox_closed_at left behind is inert. A kill (inbox_killed_at) is not a close.
export type ClosedFields = {
  inbox_closed_at?: number | null;
  inbox_dismissed_at?: number | null;
  inbox_killed_at?: number | null;
};

export function isClosedSession(row: ClosedFields): boolean {
  return row.inbox_closed_at != null && row.inbox_closed_at === row.inbox_dismissed_at && !row.inbox_killed_at;
}

/** Whether a hide of a lead takes this member of its nested group down: the
 *  one per-child rule the server's cascade, the server's aside scan and the
 *  web's optimistic close all apply (convex cleanup.ts / lib/closeAside, web
 *  store closeInDraft). `queued`: a message waits for it (the server's
 *  has_pending_messages, the web row's has_pending). */
export function cascadeTakesDownRow(
  child: ClosedFields & { inbox_stashed_at?: number | null; is_subagent?: boolean | null; parent_conversation_id?: unknown; [k: string]: any },
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  opts: { forceKill?: boolean; close?: boolean; queued: boolean },
): boolean {
  // A stash takes only the members that are inbox rows of their own.
  if (field === "inbox_stashed_at" && isOrphanOrSubagent(child as any)) return false;
  // A quiet re-assert never re-kills.
  if (child[field] && !opts.forceKill) return false;
  // A close leaves a killed member alone (it is retired, nothing of it wakes),
  // and a closed one with nothing queued (already stopped, its wakes kept).
  if (opts.close && child.inbox_killed_at) return false;
  if (opts.close && isClosedSession(child) && !opts.queued) return false;
  return true;
}

/** A patch (or a row) that IS a close: the two stamps written together. */
export function isClosePatch(fields: ClosedFields): boolean {
  return !!fields.inbox_dismissed_at && fields.inbox_closed_at === fields.inbox_dismissed_at;
}

// What makes a session "in flight": something its own agent process holds that
// stopping it would lose. Close sets such a session aside (a stash) instead of
// stopping it, and so does a close of the lead of a nested group any member of
// which is in flight (the group comes down with its lead). One pure verdict;
// each side only gathers the facts: the web (lib/sessionClose) from the row it
// holds, the server (convex lib/closeAside) from the database.
export type InFlightFacts = {
  /** A message waits to be delivered to it. */
  queued: boolean;
  /** An armed /loop: a wakeup inside the agent process (isLoopFresh). */
  loopFresh: boolean;
  /** A Workflow-tool run, which executes inside the agent process, is running. */
  inProcessRun: boolean;
  /** Producing right now by the shared live rule. */
  turnLive: boolean;
  /** Blocked mid-turn on the person: an open poll or a permission prompt. */
  awaitingInput: boolean;
  /** Parked on a usage limit the reset or an account switch continues. */
  limitParked: boolean;
  /** Background work its harness still holds (a run_in_background Bash, a
   *  Monitor, a background Agent): it re-invokes the agent when it finishes,
   *  and dies with the process (openTasks.ts openTasksVouchForWaiting). */
  openBackgroundWork: boolean;
  /** A spawned worker waiting in its fleet's queue (subagent_slot "queued"):
   *  its start is a wake the fleet drains, so a close must not drop it. */
  fleetQueued: boolean;
};

// Every fact, at runtime: the type forces each key here, and a test holds both
// gatherers to filling exactly these (convex closeInFlight.agree.test.ts).
const IN_FLIGHT_FACT_SPEC: Record<keyof InFlightFacts, true> = {
  queued: true, loopFresh: true, inProcessRun: true, turnLive: true, awaitingInput: true, limitParked: true, openBackgroundWork: true, fleetQueued: true,
};
export const IN_FLIGHT_FACT_KEYS = Object.keys(IN_FLIGHT_FACT_SPEC) as ReadonlyArray<keyof InFlightFacts>;

export type InFlightReason = "queued" | "fleet" | "loop" | "workflow" | "live" | "awaiting" | "background" | "limit";

/** Why a close must set this session aside, or null when stopping it loses nothing. */
export function closeInFlightReason(f: InFlightFacts): InFlightReason | null {
  // A turn stopped on a permission prompt or poll waits on the person, whatever its status says.
  if (f.awaitingInput) return "awaiting";
  if (f.turnLive) return "live";
  if (f.queued) return "queued";
  if (f.inProcessRun) return "workflow";
  if (f.openBackgroundWork) return "background";
  if (f.fleetQueued) return "fleet";
  if (f.loopFresh) return "loop";
  if (f.limitParked) return "limit";
  return null;
}

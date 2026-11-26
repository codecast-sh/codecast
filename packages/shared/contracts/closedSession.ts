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

/** A session whose Close follows the "Stash and hide" rules: a role's own
 *  session, a standing anchor, or one a standing trigger wakes. Its own
 *  machine wakes (a trigger firing, a quiet send) run it out of sight as a
 *  hidden stash instead of bringing it back; it returns when it pins blocked,
 *  a trigger run completes --needs-attention, or any other message reaches it
 *  (a person's, another session's). A close of any other session comes back
 *  on its next wake. */
export function closeHidesThroughWakes(row: {
  persistent?: boolean | null;
  standing_role_id?: unknown;
  armed_trigger_kind?: string | null;
}): boolean {
  return !!row.persistent || !!row.standing_role_id || row.armed_trigger_kind === "standing";
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

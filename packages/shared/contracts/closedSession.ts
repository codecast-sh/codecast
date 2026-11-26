// A CLOSED session: the person's Close (web/phone), which stops an agent that
// has nothing in flight without retiring it. Close writes inbox_closed_at equal
// to the inbox_dismissed_at it stamps (a set-aside close, and a closed session
// a machine woke, write it equal to the stash stamp instead: isClosedHidden).
// The equality is the marker: every un-hide clears inbox_dismissed_at and every other dismissal
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

/** A closed session a machine wake (a trigger, a quiet send, another session's
 *  message) has run out of sight: a hidden stash stamped with the close's own
 *  stamp. A set-aside close (one in flight) writes the same shape. A person's
 *  own "Stash and hide" stamps the stash anew, so it never reads as one. */
export function isClosedHidden(row: ClosedFields & { inbox_stashed_at?: number | null; inbox_stash_hidden?: boolean | null }): boolean {
  return !!row.inbox_stash_hidden && row.inbox_closed_at != null && row.inbox_closed_at === row.inbox_stashed_at && !row.inbox_killed_at;
}

/** Whether a closed session comes back when its woken turn pins done. Every
 *  closed session comes back when it pins blocked, a trigger run completes
 *  --needs-attention, or a person writes. An ordinary one also comes back on
 *  done: it delivered something. A role's own session, a standing anchor or a
 *  standing trigger's home does not, since its routine runs end done. */
export function closeReturnsOnDone(row: {
  persistent?: boolean | null;
  standing_role_id?: unknown;
  armed_trigger_kind?: string | null;
}): boolean {
  return !row.persistent && !row.standing_role_id && row.armed_trigger_kind !== "standing";
}

type HideFields = ClosedFields & { inbox_stashed_at?: number | null; inbox_stash_hidden?: boolean | null };

/** What a machine wake writes over a closed session (or one person's close of
 *  a team session): the close becomes a hidden stash stamped with the close,
 *  so the agent runs out of sight (isClosedHidden). Null when it is no close. */
export function closeWakeFields(row: HideFields): { inbox_dismissed_at: undefined; inbox_stashed_at: number; inbox_stash_hidden: true } | null {
  if (!isClosedSession(row)) return null;
  // A person's own "Stash and hide" over the close wins: it keeps its stamp.
  if (row.inbox_stash_hidden && row.inbox_stashed_at && row.inbox_stashed_at !== row.inbox_closed_at) return null;
  return { inbox_dismissed_at: undefined, inbox_stashed_at: row.inbox_closed_at!, inbox_stash_hidden: true };
}

/** What a pinned thread state writes over a hidden session (performSetThreadState,
 *  on the row and on each person's own triage of a team session). `blocked`
 *  brings back any stash or dismissal; `done` brings back a closed session a
 *  machine woke (isClosedHidden) when it returns on done (closeReturnsOnDone).
 *  Null when the pin brings nothing back. */
export function pinHideFields(row: HideFields, status: string, returnsOnDone: boolean): { inbox_stashed_at: undefined; inbox_stash_hidden: undefined; inbox_dismissed_at?: undefined } | null {
  if (row.inbox_killed_at) return null;
  if (status === "blocked" && (row.inbox_stashed_at || row.inbox_dismissed_at)) return { inbox_stashed_at: undefined, inbox_stash_hidden: undefined, inbox_dismissed_at: undefined };
  if (status === "done" && returnsOnDone && isClosedHidden(row)) return { inbox_stashed_at: undefined, inbox_stash_hidden: undefined };
  return null;
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

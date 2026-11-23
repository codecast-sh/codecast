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
};

export type InFlightReason = "queued" | "loop" | "workflow" | "live" | "awaiting" | "limit";

/** Why a close must set this session aside, or null when stopping it loses nothing. */
export function closeInFlightReason(f: InFlightFacts): InFlightReason | null {
  if (f.turnLive) return "live";
  if (f.awaitingInput) return "awaiting";
  if (f.queued) return "queued";
  if (f.inProcessRun) return "workflow";
  if (f.loopFresh) return "loop";
  if (f.limitParked) return "limit";
  return null;
}

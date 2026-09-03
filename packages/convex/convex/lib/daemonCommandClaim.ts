// A claim is an exclusive lease on one daemon command.
//
// Two daemons can share one device: a launchd instance and a self spawned one,
// or the old and new process during an upgrade. Both poll the same user scoped
// queue, so before this both executed every command. A resume ran twice, a kill
// raced a resume. The claim makes the first writer the only executor.
//
// Convex mutations are serializable, so "first writer wins" needs no extra
// machinery. The lease exists only because a claimer can die holding it.

/** How long a claim holds. Longer than the slowest command this executes (a
 *  cold resume with its readiness poll), so a live claimer is never overtaken
 *  mid-flight. Shorter than the 5 minute command TTL, so a claimer that crashed
 *  strands its command for at most two minutes. */
export const CLAIM_GRACE_MS = 120_000;

export interface ClaimableCommand {
  executed_at?: number;
  claimed_by?: string;
  claimed_at?: number;
}

/** These two are the only answers that mean another daemon owns the work, so
 *  they are the only ones a caller may skip on. The mutation also answers
 *  unauthorized and not_found; those are server side problems, and a daemon
 *  that skipped on them would drop the command instead of failing open. */
export type ClaimDecision = "grant" | "already_executed" | "held_by_other";

/** Does this boot id get to run the command? Re-claiming your own live hold is
 *  granted, so a retry after a dropped response is not a deadlock. */
export function decideCommandClaim(row: ClaimableCommand, bootId: string, now: number): ClaimDecision {
  if (row.executed_at !== undefined) return "already_executed";
  if (!row.claimed_by || row.claimed_by === bootId) return "grant";
  if (now - (row.claimed_at ?? 0) >= CLAIM_GRACE_MS) return "grant";
  return "held_by_other";
}

/** Should this command still be offered to a daemon? A held command is hidden
 *  from everyone but its holder until the lease lapses.
 *
 *  An undefined bootId is a daemon too old to claim: it sees everything, which
 *  is the same shape that keeps the device_id filter safe during a rollout. */
export function commandVisibleToClaimer(
  row: ClaimableCommand,
  bootId: string | undefined,
  now: number,
): boolean {
  if (bootId === undefined) return true;
  return decideCommandClaim(row, bootId, now) !== "held_by_other";
}

// A claim is an exclusive lease on one daemon command, held by one process on
// one device.
//
// Two daemons can share a device: a launchd instance and a self spawned one, or
// the old and new process during an upgrade. Both poll the same user scoped
// queue, so before this both executed every command. A resume ran twice, a kill
// raced a resume. The claim makes the first writer the only executor.
//
// The lease is scoped to a DEVICE, and that scope is load bearing. Many
// commands are inserted with no target device on purpose, so that every machine
// on the account runs them: kill_session sweeps each device for its own panes
// (deferring to one owner left owner mismatched panes unkillable everywhere),
// and an admin restart or a desktop update is one row per user meant for the
// whole fleet. A user scoped lease would hand each of those to whichever daemon
// answered first and hide it from the rest. So a hold by another device is a
// grant: only two daemons on the SAME device contend, which is the split brain
// this exists to stop.
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
  claimed_device?: string;
}

/** Who is asking. The boot id names the process, the device names the machine.
 *  Either can be missing during a rollout, and both missing values fail toward
 *  the old behaviour: an unknown boot id sees and claims everything, an unknown
 *  device contends with every holder rather than none. */
export interface Claimer {
  bootId: string;
  deviceId?: string;
}

/** These two are the only answers that mean another daemon owns the work, so
 *  they are the only ones a caller may skip on. The mutation also answers
 *  unauthorized and not_found; those are server side problems, and a daemon
 *  that skipped on them would drop the command instead of failing open. */
export type ClaimDecision = "grant" | "already_executed" | "held_by_other";

/** Does this claimer get to run the command? Re-claiming your own live hold is
 *  granted, so a retry after a dropped response is not a deadlock. */
export function decideCommandClaim(row: ClaimableCommand, claimer: Claimer, now: number): ClaimDecision {
  if (row.executed_at !== undefined) return "already_executed";
  if (!row.claimed_by || row.claimed_by === claimer.bootId) return "grant";
  // A hold from another machine says nothing about this one. Both sides of the
  // comparison have to be known: a hold written before the device rode along
  // has no device, and treating that as "elsewhere" would drop the lease for
  // the two minutes it takes such rows to age out.
  if (row.claimed_device && claimer.deviceId && row.claimed_device !== claimer.deviceId) return "grant";
  if (now - (row.claimed_at ?? 0) >= CLAIM_GRACE_MS) return "grant";
  return "held_by_other";
}

/** Should this command still be offered to a daemon? A held command is hidden
 *  from the other daemons ON ITS DEVICE until the lease lapses.
 *
 *  An undefined bootId is a daemon too old to claim: it sees everything, which
 *  is the same shape that keeps the device_id filter safe during a rollout. */
export function commandVisibleToClaimer(
  row: ClaimableCommand,
  bootId: string | undefined,
  deviceId: string | undefined,
  now: number,
): boolean {
  if (bootId === undefined) return true;
  return decideCommandClaim(row, { bootId, deviceId }, now) !== "held_by_other";
}

/** May this claimer drop its own hold? Only the holder can, so a stale release
 *  from a process that already lost the lease cannot free a live one. */
export function canReleaseCommandClaim(row: ClaimableCommand, claimer: Claimer): boolean {
  return row.executed_at === undefined && !!row.claimed_by && row.claimed_by === claimer.bootId;
}

import type { Id } from "../_generated/dataModel";

// The users doc is HOT: webListPaginated and the daemon-health queries read
// it, and every daemon mutation that stamps liveness writes it. Readers only
// need minute-granularity online detection, so daemon_last_seen is refreshed
// at most once per window. An unconditional stamp per call made a daemon that
// registers a batch of sessions write the same row dozens of times a second,
// and those mutations (plus the heartbeat) failed on OCC (2026-09-30, 2026-10-16).
export const DAEMON_LAST_SEEN_THROTTLE_MS = 50 * 1000;

export function daemonLastSeenStale(lastSeen: number | undefined, now: number): boolean {
  return !lastSeen || now - lastSeen > DAEMON_LAST_SEEN_THROTTLE_MS;
}

/** Stamp the user's daemon_last_seen, skipping the write while it is fresh. */
export async function touchDaemonLastSeen(
  ctx: { db: any },
  userId: Id<"users">,
  user?: { daemon_last_seen?: number } | null,
): Promise<void> {
  const now = Date.now();
  const current = user === undefined ? await ctx.db.get(userId) : user;
  if (!current || !daemonLastSeenStale(current.daemon_last_seen, now)) return;
  await ctx.db.patch(userId, { daemon_last_seen: now });
}

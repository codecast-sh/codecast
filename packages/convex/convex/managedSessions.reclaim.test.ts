import { describe, expect, test } from "bun:test";
import { CROSS_USER_RECLAIM_STALE_MS, canReclaimCrossUser } from "./managedSessions";

// Incident 2026-07-06: a test-rig daemon authed as a different user called
// registerManagedSession for nine sessions it could see on the shared tmux
// server, and the unconditional cross-user reclaim deleted the live daemon's
// rows — rerouting message delivery and freezing the threads. The reclaim must
// be a lease takeover, never a live steal.
describe("canReclaimCrossUser", () => {
  const now = 1_000_000_000;

  test("refuses while the owner's heartbeat is fresh (the hijack)", () => {
    expect(canReclaimCrossUser(now - 30_000, now)).toBe(false);
    // Worst-case legitimate staleness under HEARTBEAT_REFRESH_MS throttling.
    expect(canReclaimCrossUser(now - 90_000, now)).toBe(false);
  });

  test("allows once the owner is provably gone (logout/login resurface)", () => {
    expect(canReclaimCrossUser(now - CROSS_USER_RECLAIM_STALE_MS, now)).toBe(true);
    expect(canReclaimCrossUser(now - 10 * 60 * 1000, now)).toBe(true);
  });
});

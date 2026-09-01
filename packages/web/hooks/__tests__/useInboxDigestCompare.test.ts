import { describe, expect, it } from "bun:test";
import { startInboxDigestCompare } from "../useInboxDigestCompare";
import { INBOX_COMPARE_TICK_MS } from "../../store/inboxDigestCompare";
import { useInboxStore } from "../../store/inboxStore";

// The anti-entropy loop's mount, without React: it subscribes ONE listener to
// the shared coarse clock at the compare cadence (no private interval), each
// tick runs the comparer over the live store, and dispose unsubscribes and
// disposes the comparer. The IO surface is wired to the real store paths
// (applyHealedSessions / applyInboxLivenessPayload); a cold store makes every
// tick a cold_replica skip, which is enough to prove the loop turns.

describe("startInboxDigestCompare", () => {
  it("subscribes at INBOX_COMPARE_TICK_MS, ticks the comparer on each tick, and unsubscribes on dispose", () => {
    useInboxStore.setState({ sessions: {}, sessionsProjection: {}, currentUser: null } as any);
    let listener: (() => void) | null = null;
    let subscribedAt = 0;
    let unsubscribed = 0;
    const convex = { query: async () => ({}) };
    const handle = startInboxDigestCompare(convex, (intervalMs, fn) => {
      subscribedAt = intervalMs;
      listener = fn;
      return () => {
        unsubscribed++;
        listener = null;
      };
    });
    expect(subscribedAt).toBe(INBOX_COMPARE_TICK_MS);
    expect(listener).not.toBeNull();
    listener!();
    listener!();
    expect(handle.comparer.counters().skips.cold_replica).toBe(2);
    handle.dispose();
    expect(unsubscribed).toBe(1);
    // A disposed comparer answers "disabled" to any further tick.
    expect(handle.comparer.tick(useInboxStore.getState() as any)).toEqual({ kind: "disabled" });
  });
});

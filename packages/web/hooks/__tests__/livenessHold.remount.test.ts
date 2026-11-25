import { describe, expect, it } from "bun:test";
import { startLivenessHold, type LivenessHoldIO } from "../livenessHold";
import { selectSyncFlags } from "../../components/SyncStatusChip";

// ct-101309: right after joining a team, the header read "Sync status:
// Syncing" for 18s on every page (replay rp-24824), though the setup flow had
// been syncing that team live for the previous 100s.
//
// The join flow (/settings/team/join) renders under SetupScreen, which mounts
// its own DashboardSyncEffects; "Open team" moves to the dashboard shell,
// which mounts another. The feeders remount, so useSyncInboxSessions stops
// the liveness hold and starts a new one, and the new one's boot treats the
// store as a launch from cache: it holds at the latest heartbeat, the sync LED
// lights (selectSyncFlags reads livenessHeldAt), and placement is frozen until
// a round-trip sessionsLiveness read lands. Nothing was suspended and the
// socket never dropped: the facts were current a moment ago.

const T0 = 1_800_000_000_000;

/** One store and one socket shared by every controller started on it, as one
 *  window's store outlives a remount of its feeders. */
function windowRig() {
  let now = T0;
  const connected = true;
  let heldAt: number | null = null;
  let seq = 0;
  // A brand-new member: the cache hydrates empty, the team's sessions arrive
  // over the live subscription after the join.
  const sessions: Record<string, { last_heartbeat?: number | null }> = {};
  const reads: Array<(applied: boolean) => void> = [];
  const listeners = { tick: new Set<() => void>(), conn: new Set<() => void>(), wake: new Set<() => void>(), store: new Set<() => void>() };
  const on = (set: Set<() => void>) => (fn: () => void) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const io: LivenessHoldIO = {
    now: () => now,
    hydrated: () => true,
    sessions: () => sessions,
    heldAt: () => heldAt,
    holdSeq: () => seq,
    hold: (at) => {
      heldAt = heldAt == null ? at : Math.min(heldAt, at);
      seq++;
    },
    release: (s) => {
      if (s === seq) heldAt = null;
    },
    probe: () => new Promise<boolean>((resolve) => reads.push(resolve)),
    connected: () => connected,
    hidden: () => false,
    onTick: on(listeners.tick),
    onConnection: on(listeners.conn),
    onWake: on(listeners.wake),
    onStore: on(listeners.store),
  };
  const fire = (set: Set<() => void>) => [...set].forEach((fn) => fn());
  return {
    start: () => startLivenessHold(io),
    held: () => heldAt,
    reads,
    /** Live time passing with the socket up: the 15s coarse tick, and the
     *  team's sessions heartbeating through the live subscription. */
    live: (ms: number) => {
      for (let t = 0; t < ms; t += 15_000) {
        now += 15_000;
        for (let i = 0; i < 6; i++) sessions[`team_s${i}`] = { last_heartbeat: now - 2_000 };
        fire(listeners.store);
        fire(listeners.tick);
      }
    },
  };
}

describe("liveness hold across a feeder remount (ct-101309)", () => {
  it("entering the dashboard from the join flow does not re-hold facts the live subscription just kept current", () => {
    const w = windowRig();

    // The join flow's feeders (SetupScreen → DashboardSyncEffects).
    const stopSetup = w.start();
    expect(w.held()).toBeNull(); // empty cache at boot: nothing to hold
    w.live(100_000); // 1:40 of the guided join, socket up, team syncing live
    expect(w.held()).toBeNull();

    // "Open team ↵": SetupScreen unmounts, the dashboard shell mounts its own.
    stopSetup();
    w.start();

    // The same window, the same connected socket, heartbeats 2s old. Holding
    // here is what lit "Sync status: Syncing" on every page after the join.
    expect(selectSyncFlags({ liveLoading: {}, livenessHeldAt: w.held() })).toBe(0);
    expect(w.held()).toBeNull();
    expect(w.reads.length).toBe(0);
  });
});

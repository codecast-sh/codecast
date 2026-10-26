import { describe, expect, it } from "bun:test";
import { LIVENESS_HIDDEN_SUSPEND_GAP_MS, LIVENESS_SUSPEND_GAP_MS, startLivenessHold, type LivenessHoldIO } from "../livenessHold";

// The controller that decides when the device's liveness facts may be stale
// (a launch from cache, a suspension, a dropped socket) and when a fresh read
// has made them current again.
const T0 = 1_800_000_000_000;

function rig(opts: { hydrated?: boolean; heartbeats?: number[]; hidden?: boolean } = {}) {
  let now = T0;
  let hidden = opts.hidden ?? false;
  let hydrated = opts.hydrated ?? true;
  let connected = true;
  let heldAt: number | null = null;
  let seq = 0;
  const reads: Array<{ resolve: (applied: boolean) => void }> = [];
  const listeners = { tick: new Set<() => void>(), conn: new Set<() => void>(), wake: new Set<() => void>(), store: new Set<() => void>() };
  const on = (set: Set<() => void>) => (fn: () => void) => {
    set.add(fn);
    return () => set.delete(fn);
  };
  const sessions = Object.fromEntries((opts.heartbeats ?? []).map((b, i) => [`s${i}`, { last_heartbeat: b }]));
  const io: LivenessHoldIO = {
    now: () => now,
    hydrated: () => hydrated,
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
    probe: () => new Promise<boolean>((resolve) => reads.push({ resolve })),
    connected: () => connected,
    hidden: () => hidden,
    onTick: on(listeners.tick),
    onConnection: on(listeners.conn),
    onWake: on(listeners.wake),
    onStore: on(listeners.store),
  };
  const fire = (set: Set<() => void>) => [...set].forEach((fn) => fn());
  const stop = startLivenessHold(io);
  return {
    stop,
    reads,
    held: () => heldAt,
    advance: (ms: number) => { now += ms; },
    tick: () => fire(listeners.tick),
    wake: () => fire(listeners.wake),
    setConnected: (c: boolean) => { connected = c; fire(listeners.conn); },
    hydrate: () => { hydrated = true; fire(listeners.store); },
    setHidden: (h: boolean) => { hidden = h; },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("liveness hold", () => {
  it("holds a launch from cache at its latest heartbeat until a fresh read lands", async () => {
    const r = rig({ hydrated: false, heartbeats: [T0 - 3_600_000, T0 - 600_000] });
    expect(r.held()).toBeNull();
    r.hydrate();
    expect(r.held()).toBe(T0 - 600_000);
    expect(r.reads.length).toBe(1);
    r.reads[0].resolve(true);
    await settle();
    expect(r.held()).toBeNull();
  });

  it("does not hold an empty cache", () => {
    const r = rig({ heartbeats: [] });
    expect(r.held()).toBeNull();
    expect(r.reads.length).toBe(0);
  });

  it("holds a suspension at the last moment the process ran", async () => {
    const r = rig();
    r.advance(15_000);
    r.tick();
    expect(r.held()).toBeNull();
    const lastRan = T0 + 15_000;
    r.advance(LIVENESS_SUSPEND_GAP_MS + 60_000);
    r.wake();
    expect(r.held()).toBe(lastRan);
    r.reads[0].resolve(true);
    await settle();
    expect(r.held()).toBeNull();
  });

  it("holds through a dropped socket and reads again on reconnect", async () => {
    const r = rig();
    r.advance(15_000);
    r.tick();
    r.advance(5_000);
    // Held at the last moment the socket was seen up.
    r.setConnected(false);
    expect(r.held()).toBe(T0 + 15_000);
    expect(r.reads.length).toBe(0); // nothing to read through while offline
    r.advance(120_000);
    r.tick();
    expect(r.held()).toBe(T0 + 15_000);
    r.setConnected(true);
    expect(r.reads.length).toBe(1);
    r.reads[0].resolve(true);
    await settle();
    expect(r.held()).toBeNull();
  });

  it("a read started before a newer hold does not release it", async () => {
    const r = rig();
    r.advance(5_000);
    r.setConnected(false);
    r.setConnected(true);
    expect(r.reads.length).toBe(1);
    // The process is suspended while that read is in flight.
    r.advance(LIVENESS_SUSPEND_GAP_MS + 60_000);
    r.wake();
    r.reads[0].resolve(true);
    await settle();
    expect(r.held()).not.toBeNull();
    expect(r.reads.length).toBe(2);
    r.reads[1].resolve(true);
    await settle();
    expect(r.held()).toBeNull();
  });

  it("keeps holding when the read fails, and retries on the next tick", async () => {
    const r = rig();
    r.advance(5_000);
    r.setConnected(false);
    r.setConnected(true);
    r.reads[0].resolve(false);
    await settle();
    expect(r.held()).not.toBeNull();
    r.advance(15_000);
    r.tick();
    expect(r.reads.length).toBe(2);
  });

  it("a hidden tab's throttled timers are not a suspension", () => {
    // Chrome runs a hidden tab's timers about once a minute: each late tick
    // used to place a new hold that refused the read in flight, so the hold
    // never lifted.
    const r = rig({ hidden: true });
    for (let i = 0; i < 5; i++) {
      r.advance(70_000);
      r.tick();
    }
    expect(r.held()).toBeNull();
    // A real sleep is longer than any throttling, and coming back visible is checked against it.
    r.advance(LIVENESS_HIDDEN_SUSPEND_GAP_MS + 60_000);
    r.setHidden(false);
    r.wake();
    expect(r.held()).toBe(T0 + 5 * 70_000);
  });
});

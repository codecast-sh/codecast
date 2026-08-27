import { describe, expect, it } from "bun:test";
import {
  shouldRecover,
  createRecoveryController,
} from "../useRecoveryPoll";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shouldRecover", () => {
  it("fires once the tracked value is stale past the threshold", () => {
    expect(shouldRecover(1000, 0, 500, false)).toBe(true); // 1000ms stale > 500
    expect(shouldRecover(500, 0, 500, false)).toBe(true); // exactly at threshold
  });

  it("stays a no-op while the value is still fresh", () => {
    expect(shouldRecover(400, 0, 500, false)).toBe(false);
  });

  it("never starts a second fetch while one is in flight", () => {
    expect(shouldRecover(10_000, 0, 500, true)).toBe(false);
  });
});

describe("createRecoveryController", () => {
  it("runs the fetch when stale and skips it when fresh", async () => {
    let calls = 0;
    let nowMs = 1000;
    const c = createRecoveryController({
      getLastSync: () => 0,
      staleMs: 500,
      now: () => nowMs,
      fetchAndApply: async () => {
        calls++;
      },
    });

    await c.tick();
    expect(calls).toBe(1);
    expect(c.isInFlight()).toBe(false);

    // Pretend the fetch refreshed the value: now fresh, so the next tick skips.
    nowMs = 1000;
    const fresh = createRecoveryController({
      getLastSync: () => 900,
      staleMs: 500,
      now: () => 1000,
      fetchAndApply: async () => {
        calls++;
      },
    });
    await fresh.tick();
    expect(calls).toBe(1);
  });

  it("does not overlap concurrent fetches", async () => {
    let calls = 0;
    let release!: () => void;
    const c = createRecoveryController({
      getLastSync: () => 0,
      staleMs: 500,
      now: () => 10_000,
      fetchAndApply: () =>
        new Promise<void>((resolve) => {
          calls++;
          release = resolve;
        }),
    });

    const first = c.tick();
    expect(c.isInFlight()).toBe(true);
    await c.tick(); // gated by in-flight — must not start a second fetch
    expect(calls).toBe(1);

    release();
    await first;
    expect(c.isInFlight()).toBe(false);
  });

  it("a hung fetch can't wedge recovery forever — the timeout releases it", async () => {
    let calls = 0;
    const c = createRecoveryController({
      getLastSync: () => 0,
      staleMs: 500,
      now: () => 10_000,
      timeoutMs: 20,
      // Never resolves: simulates a one-shot query stuck on a reconnecting socket.
      fetchAndApply: () =>
        new Promise<void>(() => {
          calls++;
        }),
    });

    void c.tick();
    expect(c.isInFlight()).toBe(true);
    expect(calls).toBe(1);

    // Past the timeout, the guard must clear in-flight so a later tick retries
    // instead of early-returning until a page reload.
    await sleep(40);
    expect(c.isInFlight()).toBe(false);

    void c.tick();
    expect(calls).toBe(2);
  });

  it("swallows fetch errors and clears in-flight so the next tick can retry", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const c = createRecoveryController({
      getLastSync: () => 0,
      staleMs: 500,
      now: () => 10_000,
      onError: (e) => errors.push(e),
      fetchAndApply: async () => {
        calls++;
        throw new Error("boom");
      },
    });

    await c.tick();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(c.isInFlight()).toBe(false);

    await c.tick();
    expect(calls).toBe(2);
  });

  it("backs off while probes keep missing (no live push between them)", async () => {
    // Models the cold-open case: the live subscription's first payload is
    // pending on a slow server, and each probe is a full recompute on top.
    let calls = 0;
    let lastSync = 0;
    let nowMs = 0;
    const c = createRecoveryController({
      getLastSync: () => lastSync,
      staleMs: 100,
      maxStaleMs: 400,
      now: () => nowMs,
      fetchAndApply: async () => {
        calls++;
        lastSync = nowMs; // the probe itself refreshes the watermark
      },
    });

    nowMs = 100; await c.tick(); expect(calls).toBe(1);   // base cadence
    nowMs = 200; await c.tick(); expect(calls).toBe(2);   // first miss only known now
    nowMs = 300; await c.tick(); expect(calls).toBe(2);   // one miss → needs 200ms
    nowMs = 400; await c.tick(); expect(calls).toBe(3);
    nowMs = 700; await c.tick(); expect(calls).toBe(3);   // two misses → 400ms
    nowMs = 800; await c.tick(); expect(calls).toBe(4);
    nowMs = 1200; await c.tick(); expect(calls).toBe(5);  // capped at maxStaleMs
    expect(c.requiredStaleMs()).toBe(400);

    // A live push moves the watermark without a probe → back to base cadence.
    lastSync = 1250;
    nowMs = 1360; await c.tick(); expect(calls).toBe(6);
    expect(c.requiredStaleMs()).toBe(100);
  });

  it("wake defers the probe past the resubscribe grace and skips it if a push landed", async () => {
    let calls = 0;
    let lastSync = 0;
    const c = createRecoveryController({
      getLastSync: () => lastSync,
      staleMs: 10_000,
      wakeGraceMs: 30,
      fetchAndApply: async () => {
        calls++;
      },
    });
    c.wake();
    c.wake(); // coalesces into the pending one
    expect(calls).toBe(0);
    lastSync = Date.now(); // the resubscribe delivered inside the grace window
    await sleep(50);
    expect(calls).toBe(0);

    lastSync = 0;
    c.wake();
    await sleep(50);
    expect(calls).toBe(1); // nothing arrived → the deferred probe fires
    c.dispose();
  });
});

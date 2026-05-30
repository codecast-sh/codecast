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
});

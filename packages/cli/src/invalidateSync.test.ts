import { describe, it, expect } from "bun:test";
import { InvalidateSync, delay, exponentialBackoffDelay } from "./invalidateSync.js";

describe("InvalidateSync", () => {
  it("should execute command on invalidate", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    });

    sync.invalidate();
    await delay(50);

    expect(executed).toBe(1);
  });

  it("should handle double invalidation during sync", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      await delay(50);
      executed++;
    });

    sync.invalidate();
    await delay(10);
    sync.invalidate();
    await delay(10);
    sync.invalidate();

    await delay(200);

    expect(executed).toBe(2);
  });

  it("should queue multiple awaiters", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      await delay(50);
      executed++;
    });

    const promises = [
      sync.invalidateAndAwait(),
      sync.invalidateAndAwait(),
      sync.invalidateAndAwait(),
    ];

    await Promise.all(promises);

    expect(executed).toBeGreaterThan(0);
  });

  it("should stop processing when stopped", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    });

    sync.stop();
    sync.invalidate();

    await delay(50);

    expect(executed).toBe(0);
  });

  it("should retry on failure with backoff", async () => {
    let attempts = 0;
    const sync = new InvalidateSync(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("Simulated failure");
      }
    });

    sync.invalidate();
    await delay(2000);

    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});

describe("InvalidateSync debounce", () => {
  it("coalesces a burst of invalidations into a single run", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    }, { debounceMs: 100, maxWaitMs: 1000 });

    // Fire several events within the debounce window — should collapse to one run.
    sync.invalidate();
    await delay(20);
    sync.invalidate();
    await delay(20);
    sync.invalidate();

    // Before the window elapses, nothing has run yet.
    expect(executed).toBe(0);

    await delay(150);
    expect(executed).toBe(1);
  });

  it("flushes via maxWait when events never pause", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    }, { debounceMs: 100, maxWaitMs: 250 });

    // Keep resetting the debounce faster than debounceMs; maxWait must still fire.
    for (let i = 0; i < 8; i++) {
      sync.invalidate();
      await delay(60);
    }

    expect(executed).toBeGreaterThanOrEqual(1);
  });

  it("invalidateAndAwait bypasses debounce and runs promptly", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    }, { debounceMs: 5000, maxWaitMs: 10000 });

    await sync.invalidateAndAwait();
    expect(executed).toBe(1);
  });

  it("stop() cancels a pending debounced run", async () => {
    let executed = 0;
    const sync = new InvalidateSync(async () => {
      executed++;
    }, { debounceMs: 100 });

    sync.invalidate();
    sync.stop();
    await delay(150);

    expect(executed).toBe(0);
  });
});

describe("exponentialBackoffDelay", () => {
  it("should produce reasonable delays", () => {
    const delay1 = exponentialBackoffDelay(1, 100, 5000, 10);
    const delay2 = exponentialBackoffDelay(5, 100, 5000, 10);
    const delay3 = exponentialBackoffDelay(10, 100, 5000, 10);

    expect(delay1).toBeGreaterThanOrEqual(0);
    expect(delay2).toBeGreaterThanOrEqual(0);
    expect(delay3).toBeGreaterThanOrEqual(0);
  });

  it("should respect bounds", () => {
    const delay = exponentialBackoffDelay(5, 100, 1000, 10);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

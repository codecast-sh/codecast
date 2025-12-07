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

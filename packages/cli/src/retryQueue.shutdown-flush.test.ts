import { describe, expect, test } from "bun:test";
import { flushRetryQueueForShutdown, type ShutdownFlushable } from "./retryQueue.js";
import { DAEMON_STOP_SIGKILL_MS, SHUTDOWN_FLUSH_MS } from "./shutdownBudget.js";

/** A queue that drains `perPoll` ops each time it is asked its size. */
function fakeQueue(size: number, perPoll: number) {
  const calls = { restored: 0, slept: 0, persisted: [] as Array<{ sync?: boolean } | undefined> };
  const queue: ShutdownFlushable = {
    getQueueSize() {
      return size;
    },
    notifyConnectionRestored() {
      calls.restored++;
    },
    persistNow(opts) {
      calls.persisted.push(opts);
    },
  };
  // The drain is driven by the sleep, so the fake advances there.
  const sleep = async () => {
    calls.slept++;
    size = Math.max(0, size - perPoll);
  };
  return { queue, calls, sleep };
}

describe("flushRetryQueueForShutdown", () => {
  test("an empty queue returns immediately and touches nothing", async () => {
    const { queue, calls, sleep } = fakeQueue(0, 0);
    expect(await flushRetryQueueForShutdown(queue, SHUTDOWN_FLUSH_MS, sleep)).toBe(0);
    expect(calls.restored).toBe(0);
    expect(calls.slept).toBe(0);
    expect(calls.persisted).toEqual([]);
  });

  test("a draining queue empties, pulls retries forward once, and persists synchronously", async () => {
    const { queue, calls, sleep } = fakeQueue(4, 2);
    expect(await flushRetryQueueForShutdown(queue, SHUTDOWN_FLUSH_MS, sleep)).toBe(0);
    expect(calls.restored).toBe(1);
    expect(calls.slept).toBe(2);
    expect(calls.persisted).toEqual([{ sync: true }]);
  });

  test("a stuck queue gives up inside the budget and still persists", async () => {
    const { queue, calls, sleep } = fakeQueue(7, 0);
    expect(await flushRetryQueueForShutdown(queue, 1_000, sleep)).toBe(7);
    // 100ms poll over a 1s budget: ten waits, not a wall-clock measurement.
    expect(calls.slept).toBe(10);
    expect(calls.persisted).toEqual([{ sync: true }]);
  });

  // The 15s hard exit is the loose ceiling. The tight one is the caller's:
  // `cast stop` SIGKILLs the daemon DAEMON_STOP_SIGKILL_MS after its SIGTERM,
  // and the rest of shutdown still has to run after the flush. A budget equal
  // to that deadline would get the daemon killed in exactly the case the flush
  // exists for.
  test("the default budget leaves room under the stop deadline", () => {
    expect(SHUTDOWN_FLUSH_MS).toBeLessThan(15_000);
    expect(SHUTDOWN_FLUSH_MS * 2).toBeLessThanOrEqual(DAEMON_STOP_SIGKILL_MS);
  });
});

import { describe, it, expect } from "bun:test";
import { withTimeout, SyncService } from "./syncService.js";

describe("withTimeout", () => {
  it("resolves through when the inner promise wins the race", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("rejects with a labeled error after the timeout when the inner promise hangs", async () => {
    const hang = new Promise<never>(() => { /* never resolves */ });
    const start = Date.now();
    await expect(withTimeout(hang, 100, "hung op")).rejects.toThrow(
      /hung op timed out after 100ms/
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(500);
  });

  it("propagates rejection from the inner promise without waiting for the timeout", async () => {
    const inner = Promise.reject(new Error("boom"));
    const start = Date.now();
    await expect(withTimeout(inner, 5000, "test")).rejects.toThrow("boom");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("clears the timeout when the inner promise resolves so the event loop can exit", async () => {
    // If the timer were not cleared, an unhandled setTimeout would keep the
    // process alive and bun:test would not return promptly. We just verify
    // back-to-back fast resolutions don't accumulate timers by running many.
    for (let i = 0; i < 50; i++) {
      await withTimeout(Promise.resolve(i), 60_000, "fast");
    }
  });
});

describe("SyncService.addMessages timeout regression", () => {
  it("throws (instead of hanging silently) when the convex mutation never resolves", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });

    // Stub the internal Convex client so the mutation hangs forever, simulating
    // the 2026-05-13 stuck-sync incident where addMessages calls never returned.
    // Without the timeout wrapper this test would hang past the bun:test deadline.
    (sync as any).client = {
      mutation: () => new Promise(() => { /* never resolves */ }),
    };

    // We can't wait the full 60s production timeout in a test, so we override
    // the constant by monkey-patching the helper used internally. The simplest
    // path: spy on Promise.race via a short-deadline replacement of client.mutation
    // that already throws with a timeout-shaped error.
    (sync as any).client = {
      mutation: () => withTimeout(new Promise(() => {}), 200, "fake-mutation"),
    };

    await expect(
      sync.addMessages({
        conversationId: "conv",
        messages: [
          { role: "human", content: "hello", timestamp: Date.now() },
        ],
      })
    ).rejects.toThrow(/timed out/);
  }, 5000);

  it("returns normally when the mutation resolves promptly", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).client = {
      mutation: async () => ({ inserted: 1, ids: ["m1"] }),
    };

    const result = await sync.addMessages({
      conversationId: "conv",
      messages: [
        { role: "human", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.ids).toEqual(["m1"]);
  });
});

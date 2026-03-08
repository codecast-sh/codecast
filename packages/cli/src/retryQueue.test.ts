import { describe, it, expect, beforeEach } from "bun:test";
import { RetryQueue } from "./retryQueue.js";

describe("RetryQueue", () => {
  let queue: RetryQueue;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    queue = new RetryQueue({
      initialDelayMs: 50,
      maxDelayMs: 400,
      maxAttempts: 3,
      onLog: (msg) => logs.push(msg),
    });
  });

  it("should add operations to queue", () => {
    const id = queue.add("addMessage", { content: "test" });
    expect(id).toMatch(/^addMessage-/);
    expect(queue.getQueueSize()).toBe(1);
    expect(logs).toContain(`Queued addMessage for retry (id: ${id})`);
  });

  it("should execute operations after delay", async () => {
    let executed = false;
    queue.setExecutor(async () => {
      executed = true;
      return true;
    });

    queue.add("addMessage", { content: "test" });
    expect(executed).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(executed).toBe(true);
    expect(queue.getQueueSize()).toBe(0);
  });

  it("should retry failed operations with exponential backoff", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      if (attempts < 3) throw new Error("Server error 500");
      return true;
    });

    queue.add("addMessage", { content: "test" });

    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1);
    expect(queue.getQueueSize()).toBe(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(attempts).toBe(2);
    expect(queue.getQueueSize()).toBe(1);

    await new Promise((r) => setTimeout(r, 300));
    expect(attempts).toBe(3);
    expect(queue.getQueueSize()).toBe(0);
  });

  it("should drop non-network operations after max attempts", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      throw new Error("Validation error: invalid field");
    });

    queue.add("createConversation", { sessionId: "test" });

    await new Promise((r) => setTimeout(r, 600));

    expect(attempts).toBe(3);
    expect(queue.getQueueSize()).toBe(0);

    const maxRetriesLog = logs.find((l) => l.includes("Max retries reached"));
    expect(maxRetriesLog).toBeDefined();
    expect(maxRetriesLog).toContain("DROPPED");
  });

  it("should NEVER drop network errors", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      if (attempts >= 6) return true; // succeed on 6th attempt
      throw new Error("fetch failed: unable to connect");
    });

    queue.add("addMessage", { content: "test" });

    // Wait long enough for 6+ attempts (maxAttempts=3, but network errors are unlimited)
    await new Promise((r) => setTimeout(r, 3000));

    expect(attempts).toBe(6);
    expect(queue.getQueueSize()).toBe(0);

    const droppedLog = logs.find((l) => l.includes("DROPPED"));
    expect(droppedLog).toBeUndefined();

    const successLog = logs.find((l) => l.includes("Retry succeeded"));
    expect(successLog).toBeDefined();
  });

  it("should identify various network error patterns", async () => {
    const networkErrors = [
      "fetch failed",
      "unable to connect",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "network error occurred",
      "socket hang up",
      "Typo in the URL",
    ];

    // Run all in parallel to avoid sequential timeout
    const results = await Promise.all(networkErrors.map(async (errMsg) => {
      let attempts = 0;
      const q = new RetryQueue({
        initialDelayMs: 10,
        maxDelayMs: 30,
        maxAttempts: 2,
        onLog: () => {},
      });

      q.setExecutor(async () => {
        attempts++;
        if (attempts >= 4) return true;
        throw new Error(errMsg);
      });

      q.add("addMessage", { content: "test" });
      await new Promise((r) => setTimeout(r, 1000));
      const result = { errMsg, attempts, queueSize: q.getQueueSize() };
      q.stop();
      return result;
    }));

    for (const { errMsg, attempts, queueSize } of results) {
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(queueSize).toBe(0);
    }
  });

  it("should still drop non-network errors at maxAttempts", async () => {
    const nonNetworkErrors = [
      "Invalid argument: field required",
      "Authentication failed",
      "Not found",
      "Internal server error",
    ];

    for (const errMsg of nonNetworkErrors) {
      const q = new RetryQueue({
        initialDelayMs: 20,
        maxDelayMs: 50,
        maxAttempts: 2,
        onLog: (msg) => logs.push(msg),
      });

      q.setExecutor(async () => {
        throw new Error(errMsg);
      });

      q.add("addMessage", { content: "test" });
      await new Promise((r) => setTimeout(r, 300));

      expect(q.getQueueSize()).toBe(0);
      q.stop();
    }
  });

  it("should keep retrying network errors past maxAttempts", async () => {
    let attempts = 0;
    const q = new RetryQueue({
      initialDelayMs: 20,
      maxDelayMs: 50,
      maxAttempts: 2,
      onLog: () => {},
    });

    q.setExecutor(async () => {
      attempts++;
      throw new Error("ECONNREFUSED");
    });

    q.add("addMessage", { content: "test" });
    // Wait enough for several attempts past maxAttempts=2
    // With 20ms initial: delays are 20, 40, 80, 160... need ~1s for 4+ attempts
    await new Promise((r) => setTimeout(r, 2000));

    // Should have retried well past the maxAttempts of 2
    expect(attempts).toBeGreaterThan(2);
    // Should still be in queue (not dropped)
    expect(q.getQueueSize()).toBe(1);
    q.stop();
  });

  it("should log 24h warning for stale network ops", async () => {
    const testLogs: string[] = [];
    let attempts = 0;
    const q = new RetryQueue({
      initialDelayMs: 20,
      maxDelayMs: 50,
      maxAttempts: 2,
      onLog: (msg) => testLogs.push(msg),
    });

    q.setExecutor(async () => {
      attempts++;
      // Backdate createdAt after first attempt so subsequent failures trigger the 24h check
      if (attempts === 1) {
        const ops = q.getPendingOperations();
        for (const op of ops) {
          op.createdAt = Date.now() - 25 * 60 * 60 * 1000;
        }
      }
      throw new Error("ECONNREFUSED");
    });

    q.add("addMessage", { content: "test" });
    // Wait for at least 3 attempts (createdAt is backdated after attempt 1, warning fires on attempt 2+)
    await new Promise((r) => setTimeout(r, 1000));

    expect(attempts).toBeGreaterThanOrEqual(2);
    const staleWarning = testLogs.find((l) => l.includes("retrying >24h"));
    expect(staleWarning).toBeDefined();
    expect(q.getQueueSize()).toBeGreaterThanOrEqual(1);
    q.stop();
  });

  it("should calculate exponential backoff correctly", async () => {
    const delays: number[] = [];
    let lastTime = Date.now();

    queue.setExecutor(async () => {
      const now = Date.now();
      delays.push(now - lastTime);
      lastTime = now;
      throw new Error("fail");
    });

    queue.add("addMessage", { content: "test" });

    await new Promise((r) => setTimeout(r, 600));

    expect(delays.length).toBe(3);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  it("should stop processing when cleared", () => {
    queue.setExecutor(async () => true);
    queue.add("addMessage", { content: "test" });
    expect(queue.getQueueSize()).toBe(1);

    queue.clear();
    expect(queue.getQueueSize()).toBe(0);
  });

  it("should return pending operations", () => {
    queue.add("addMessage", { content: "test1" });
    queue.add("createConversation", { sessionId: "test2" });

    const pending = queue.getPendingOperations();
    expect(pending.length).toBe(2);
    expect(pending[0].type).toBe("addMessage");
    expect(pending[1].type).toBe("createConversation");
  });

  it("should handle rate limit delays", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Rate limit: wait 1 seconds");
      return true;
    });

    queue.add("addMessage", { content: "test" });

    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1);

    // Should wait ~2 seconds for rate limit
    await new Promise((r) => setTimeout(r, 2500));
    expect(attempts).toBe(2);
    expect(queue.getQueueSize()).toBe(0);
  });
});

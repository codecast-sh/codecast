import { describe, it, expect, beforeEach, mock } from "bun:test";
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
      if (attempts < 3) throw new Error("Network error");
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

  it("should drop operations after max attempts", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      throw new Error("Always fails");
    });

    queue.add("createConversation", { sessionId: "test" });

    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(attempts).toBe(2);

    await new Promise((r) => setTimeout(r, 300));
    expect(attempts).toBe(3);
    expect(queue.getQueueSize()).toBe(0);

    const maxRetriesLog = logs.find((l) => l.includes("Max retries reached"));
    expect(maxRetriesLog).toBeDefined();
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

  it("should log retry attempts and failures", async () => {
    queue.setExecutor(async () => {
      throw new Error("Network error");
    });

    queue.add("addMessage", { content: "test" }, "Initial error");

    await new Promise((r) => setTimeout(r, 100));

    expect(logs.some((l) => l.includes("Retrying addMessage"))).toBe(true);
    expect(logs.some((l) => l.includes("Retry failed"))).toBe(true);
    expect(logs.some((l) => l.includes("Network error"))).toBe(true);
  });
});

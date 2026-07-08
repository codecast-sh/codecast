import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

  it("drains a backed-off op immediately on connection restore", async () => {
    // Repro for the "sync stalled (N)" that lingers after a laptop wake: an op
    // fails while the socket is down, gets pushed into a multi-second network
    // backoff, and would otherwise wait it out even after the socket returns.
    let attempts = 0;
    let online = false;
    const q = new RetryQueue({
      initialDelayMs: 1000, // first attempt + backoff base; backoff doubles to ~2s after one failure
      maxDelayMs: 60_000,
      maxAttempts: 10,
      onLog: () => {},
    });
    q.setExecutor(async () => {
      attempts++;
      if (!online) throw new Error("fetch failed: unable to connect");
      return true;
    });

    q.add("addMessage", { content: "test" });

    // First attempt fires (~1s), fails while "offline", and re-arms at ~now+2s.
    await new Promise((r) => setTimeout(r, 1200));
    expect(attempts).toBe(1);
    expect(q.getQueueSize()).toBe(1);

    // Socket comes back. Without the kick the op sits in its ~2s backoff.
    online = true;
    q.notifyConnectionRestored();

    // It must retry and drain well inside that backoff window — proof the kick,
    // not the natural timer, drove the retry.
    await new Promise((r) => setTimeout(r, 250));
    expect(attempts).toBe(2);
    expect(q.getQueueSize()).toBe(0);

    q.stop();
  });

  it("notifyConnectionRestored is a no-op on an empty queue", () => {
    const q = new RetryQueue({ onLog: () => {} });
    expect(() => q.notifyConnectionRestored()).not.toThrow();
    expect(q.getQueueSize()).toBe(0);
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

  it("reports zero health when the queue is empty", () => {
    expect(queue.getHealth()).toEqual({ pending: 0, oldestPendingMs: 0 });
  });

  it("reports backlog size and the oldest pending op's age", () => {
    queue.add("addMessage", { content: "a" });
    queue.add("addMessage", { content: "b" });

    // Backdate the first op to simulate a sustained stall. getPendingOperations
    // returns the live op objects, so mutating createdAt affects the queue.
    queue.getPendingOperations()[0].createdAt = Date.now() - 5 * 60 * 1000;

    const health = queue.getHealth();
    expect(health.pending).toBe(2);
    expect(health.oldestPendingMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it("reports logical queue size by conversation for addMessages", () => {
    queue.add("addMessages", { conversationId: "hot-a", messages: [{ messageUuid: "a1" }] });
    queue.add("addMessages", { conversationId: "hot-a", messages: [{ messageUuid: "a2" }] });
    queue.add("addMessages", { conversationId: "hot-b", messages: [{ messageUuid: "b1" }] });
    queue.add("addMessage", { conversationId: "other", content: "single" });

    expect(queue.getQueueSize()).toBe(3);
    expect(queue.getLogicalQueueSize()).toBe(3);
    expect(queue.getHealth().pending).toBe(3);
  });

  it("should drop stale-conversation errors on first failure (no retries)", async () => {
    // Regression: previously, "Unauthorized: can only add messages to your own
    // conversations" was treated as transient — the queue retried forever, flooding
    // prod Convex with rejected mutations. The cached conversationId is permanently
    // bad for the current api_token; only re-resolution recovers, never retries.
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      throw new Error("Unauthorized: can only add messages to your own conversations");
    });

    queue.add("addMessages", { conversationId: "stale-conv-id" });
    await new Promise((r) => setTimeout(r, 100));

    expect(attempts).toBe(1);
    expect(queue.getQueueSize()).toBe(0);
    expect(logs.some(l => l.startsWith("DROPPED addMessages: stale conversation"))).toBe(true);
  });

  it("should drop Conversation-not-found errors on first failure", async () => {
    let attempts = 0;
    queue.setExecutor(async () => {
      attempts++;
      throw new Error("Conversation not found");
    });

    queue.add("addMessage", { conversationId: "gone-conv-id" });
    await new Promise((r) => setTimeout(r, 100));

    expect(attempts).toBe(1);
    expect(queue.getQueueSize()).toBe(0);
  });

  it("splits oversized addMessages batches into 25-message chunks", () => {
    const msgs = Array.from({ length: 130 }, (_, i) => ({ uuid: `m${i}` }));
    queue.add("addMessages", { conversationId: "conv", messages: msgs });

    const pending = queue.getPendingOperations();
    expect(pending.length).toBe(Math.ceil(130 / 25));
    for (const op of pending) {
      expect(op.type).toBe("addMessages");
      const params = op.params as { messages: unknown[] };
      expect(params.messages.length).toBeLessThanOrEqual(25);
    }
    const totalMsgs = pending.reduce((n, op) => n + (op.params as { messages: unknown[] }).messages.length, 0);
    expect(totalMsgs).toBe(130);
    expect(logs.some(l => l.includes("Split oversized addMessages (130 msgs) into 6 retry chunks"))).toBe(true);
  });

  it("does not split addMessages batches at or below the chunk size", () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ uuid: `m${i}` }));
    queue.add("addMessages", { conversationId: "conv", messages: msgs });

    const pending = queue.getPendingOperations();
    expect(pending.length).toBe(1);
    expect((pending[0].params as { messages: unknown[] }).messages.length).toBe(25);
  });

  it("splits addMessages batches by serialized bytes, not only count", () => {
    const huge = "x".repeat(400_000);
    const msgs = [
      { messageUuid: "a", content: huge },
      { messageUuid: "b", content: huge },
      { messageUuid: "c", content: huge },
    ];
    queue.add("addMessages", { conversationId: "conv", messages: msgs });

    const pending = queue.getPendingOperations().filter((o) => o.params.conversationId === "conv");
    expect(pending.length).toBeGreaterThan(1);
    const totalMsgs = pending.reduce((n, op) => n + (op.params as { messages: unknown[] }).messages.length, 0);
    expect(totalMsgs).toBe(3);
  });

  it("never runs two ops for the same conversation concurrently", async () => {
    // Regression: the server addMessages mutation reads+patches the conversation
    // doc, so parallel ops for one conversation collided on that hot-doc → OCC
    // retries → 60s timeouts → re-queue → a self-amplifying stall. The queue must
    // serialize per-conversation even though global concurrency is >1.
    const q = new RetryQueue({ initialDelayMs: 10, maxDelayMs: 50, concurrency: 5, onLog: () => {} });
    let activeForConv = 0;
    let maxConcurrentForConv = 0;
    q.setExecutor(async (op) => {
      if (op.params.conversationId === "hot") {
        activeForConv++;
        maxConcurrentForConv = Math.max(maxConcurrentForConv, activeForConv);
        await new Promise((r) => setTimeout(r, 30));
        activeForConv--;
      }
      return true;
    });

    // 4 ops for the same conversation + 1 for another, all ready at once.
    for (let i = 0; i < 4; i++) q.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: `h${i}` }] });
    q.add("addMessages", { conversationId: "other", messages: [{ messageUuid: "o0" }] });

    await q.waitForCompletion(2000);
    expect(maxConcurrentForConv).toBe(1);
    expect(q.getQueueSize()).toBe(0);
  });

  it("does not let one hanging retry block ready work for other conversations", async () => {
    const q = new RetryQueue({ initialDelayMs: 10, maxDelayMs: 50, concurrency: 2, onLog: () => {} });
    let fastCompleted = 0;
    q.setExecutor(async (op) => {
      if (op.params.conversationId === "hot") {
        await new Promise(() => {});
      }
      fastCompleted++;
      return true;
    });

    q.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "h0" }] });
    q.add("addMessages", { conversationId: "c1", messages: [{ messageUuid: "a" }] });
    q.add("addMessages", { conversationId: "c2", messages: [{ messageUuid: "b" }] });

    await new Promise((r) => setTimeout(r, 250));
    expect(fastCompleted).toBe(2);
    expect(q.getPendingOperations().filter((o) => o.params.conversationId !== "hot").length).toBe(0);
    q.stop();
  });

  it("coalesces re-enqueued messages already pending for a conversation", async () => {
    // Regression: while a batch is stuck, the live sync path re-reads the same
    // backlog every poll and re-enqueues it, piling the same messages up 12x.
    // Re-adding messages already queued for a conversation must be a no-op.
    queue.add("addMessages", { conversationId: "c1", messages: [{ messageUuid: "a" }, { messageUuid: "b" }] });
    expect(queue.getQueueSize()).toBe(1);

    // Same two messages again → fully coalesced, no new op.
    const dup = queue.add("addMessages", { conversationId: "c1", messages: [{ messageUuid: "a" }, { messageUuid: "b" }] });
    expect(dup).toBe("");
    expect(queue.getQueueSize()).toBe(1);

    // Overlapping batch → only the genuinely-new message is queued.
    queue.add("addMessages", { conversationId: "c1", messages: [{ messageUuid: "b" }, { messageUuid: "c" }] });
    const ops = queue.getPendingOperations().filter((o) => o.params.conversationId === "c1");
    const queuedUuids = ops.flatMap((o) => (o.params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid));
    expect(queuedUuids.sort()).toEqual(["a", "b", "c"]);

    // A different conversation is unaffected by c1's pending set.
    queue.add("addMessages", { conversationId: "c2", messages: [{ messageUuid: "a" }] });
    expect(queue.getPendingOperations().some((o) => o.params.conversationId === "c2")).toBe(true);
  });

  it("compacts a conversation backlog into chunked addMessages ops", () => {
    queue.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "a" }] });
    queue.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "b" }, { messageUuid: "c" }] });
    queue.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "d" }] });

    const hotOps = queue.getPendingOperations().filter((o) => o.params.conversationId === "hot");
    expect(hotOps.length).toBe(1);
    expect((hotOps[0].params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid)).toEqual(["a", "b", "c", "d"]);
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

  it("splits a timed-out addMessages retry into smaller chunks instead of retrying the same payload forever", async () => {
    const q = new RetryQueue({ initialDelayMs: 10, maxDelayMs: 50, maxAttempts: 5, onLog: () => {} });
    const attempts: number[] = [];
    q.setExecutor(async (op) => {
      const len = (op.params.messages as unknown[]).length;
      attempts.push(len);
      if (len > 3) throw new Error(`addMessages batch (${len} msgs) timed out after 60000ms`);
      return true;
    });

    q.add("addMessages", {
      conversationId: "hot",
      messages: Array.from({ length: 6 }, (_, i) => ({ messageUuid: `m${i}` })),
    });

    await q.waitForCompletion(2000);
    expect(attempts).toContain(6);
    expect(attempts.some((n) => n < 6)).toBe(true);
    expect(q.getQueueSize()).toBe(0);
    q.stop();
  });

  it("collapses a duplicate-bloated persisted queue on load (self-heal)", () => {
    // Reproduces the 283-op / 16MB stuck queue: the live path re-enqueued the same
    // messages every poll while a batch was jammed, so disk held the same uuids 12x.
    // On restart the queue must collapse to its distinct messages, not drain dupes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-load-"));
    const persistPath = path.join(dir, "retry-queue.json");
    try {
      const dupOp = (n: number) => ({
        id: `addMessages-${n}`,
        type: "addMessages",
        params: { conversationId: "hot", messages: [{ messageUuid: "a" }, { messageUuid: "b" }] },
        attempts: 0,
        nextRetryAt: Date.now(),
        createdAt: Date.now(),
        lastError: "timed out",
      });
      // 12 identical ops for one conversation + one op for another conversation.
      const persisted = [
        ...Array.from({ length: 12 }, (_, i) => dupOp(i)),
        { id: "addMessages-other", type: "addMessages", params: { conversationId: "cold", messages: [{ messageUuid: "z" }] }, attempts: 0, nextRetryAt: Date.now(), createdAt: Date.now() },
      ];
      fs.writeFileSync(persistPath, JSON.stringify(persisted));

      const logs: string[] = [];
      const loaded = new RetryQueue({ persistPath, onLog: (m) => logs.push(m) });

      // hot: only the first op survives (a,b once); cold: untouched.
      const ops = loaded.getPendingOperations();
      const hotUuids = ops
        .filter((o) => o.params.conversationId === "hot")
        .flatMap((o) => (o.params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid));
      expect(hotUuids.sort()).toEqual(["a", "b"]);
      expect(ops.some((o) => o.params.conversationId === "cold")).toBe(true);
      expect(logs.some((l) => l.includes("deduped"))).toBe(true);

      // And the healed (collapsed) queue is rewritten to disk so the bloat is gone.
      const rewritten = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
      const totalMsgs = rewritten.reduce((n: number, o: any) => n + (o.params?.messages?.length ?? 0), 0);
      expect(totalMsgs).toBe(3); // a, b, z
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists compactly and debounced, and reloads across a restart", async () => {
    // Regression for BUG 1: every mutation used to synchronously rewrite the whole
    // queue as pretty-printed JSON, blocking the daemon's event loop. Writes must now
    // be debounced + compact, yet still survive a restart (crash-safety preserved).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-persist-"));
    const persistPath = path.join(dir, "retry-queue.json");
    try {
      const q = new RetryQueue({ persistPath, persistDebounceMs: 20, onLog: () => {} });
      q.add("addMessages", { conversationId: "c1", messages: [{ messageUuid: "a" }] });

      // Debounced: the enqueue does NOT write to disk synchronously.
      expect(fs.existsSync(persistPath)).toBe(false);

      // A single coalesced write lands after the debounce window.
      await new Promise((r) => setTimeout(r, 60));
      const raw = fs.readFileSync(persistPath, "utf-8");
      expect(raw).not.toContain("\n"); // compact, not pretty-printed
      expect(Array.isArray(JSON.parse(raw))).toBe(true);

      // A fresh queue restores the op from disk.
      const reloaded = new RetryQueue({ persistPath, onLog: () => {} });
      expect(reloaded.getPendingOperations().length).toBe(1);
      expect(reloaded.getPendingOperations()[0].params.conversationId).toBe("c1");
      reloaded.stop();
      q.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts many persisted addMessages ops for one conversation on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-compact-"));
    const persistPath = path.join(dir, "retry-queue.json");
    try {
      const persisted = Array.from({ length: 6 }, (_, i) => ({
        id: `addMessages-${i}`,
        type: "addMessages",
        params: { conversationId: "hot", messages: [{ messageUuid: `m${i}` }] },
        attempts: 0,
        nextRetryAt: Date.now(),
        createdAt: Date.now() + i,
      }));
      fs.writeFileSync(persistPath, JSON.stringify(persisted));

      const loaded = new RetryQueue({ persistPath, onLog: () => {} });
      const ops = loaded.getPendingOperations().filter((o) => o.params.conversationId === "hot");
      expect(ops.length).toBe(1);
      expect((ops[0].params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid)).toEqual([
        "m0", "m1", "m2", "m3", "m4", "m5",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts newly queued backlog behind an active conversation write", async () => {
    const q = new RetryQueue({ initialDelayMs: 10, maxDelayMs: 50, concurrency: 1, onLog: () => {} });
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      q.setExecutor(async (op) => {
        const uuids = (op.params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid);
        if (uuids[0] === "m1") {
          resolve();
          await new Promise<void>((r) => { releaseFirst = r; });
        }
        return true;
      });
    });

    q.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "m1" }] });
    await firstStarted;

    q.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "m2" }] });
    q.add("addMessages", { conversationId: "hot", messages: [{ messageUuid: "m3" }] });

    const hotOps = q.getPendingOperations().filter((o) => o.params.conversationId === "hot");
    expect(hotOps.length).toBe(2);
    const waiting = hotOps.find((o) => !(o.params.messages as Array<{ messageUuid: string }>).some((m) => m.messageUuid === "m1"));
    expect(waiting).toBeDefined();
    expect((waiting!.params.messages as Array<{ messageUuid: string }>).map((m) => m.messageUuid)).toEqual(["m2", "m3"]);

    releaseFirst();
    await q.waitForCompletion(1000);
    q.stop();
  });

  it("learns a smaller retry chunk size for a conversation after a timeout", async () => {
    const q = new RetryQueue({ initialDelayMs: 10, maxDelayMs: 50, concurrency: 1, onLog: () => {} });
    let attempts = 0;
    q.setExecutor(async (op) => {
      attempts++;
      const len = (op.params.messages as Array<unknown>).length;
      if (attempts === 1) throw new Error(`addMessages batch (${len} msgs) timed out after 60000ms`);
      return false; // keep the reshaped queue around for inspection
    });

    const mk = (start: number) => Array.from({ length: 25 }, (_, i) => ({ messageUuid: `m${start + i}` }));
    q.add("addMessages", { conversationId: "hot", messages: mk(0) });
    q.add("addMessages", { conversationId: "hot", messages: mk(100) });
    q.add("addMessages", { conversationId: "hot", messages: mk(200) });

    await new Promise((r) => setTimeout(r, 120));

    const hotOps = q.getPendingOperations().filter((o) => o.params.conversationId === "hot");
    expect(hotOps.length).toBeGreaterThan(3);
    expect(hotOps.every((o) => (o.params.messages as Array<unknown>).length <= 13)).toBe(true);
    q.stop();
  });

  it("reports whether a conversation already has queued work", () => {
    expect(queue.hasPendingConversation("hot")).toBe(false);
    queue.add("addMessages", {
      conversationId: "hot",
      messages: [{ messageUuid: "m1" }],
    });
    expect(queue.hasPendingConversation("hot")).toBe(true);
    expect(queue.hasPendingConversation("cold")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RetryQueue, defaultClassifyError, parseRateLimitDelay } from "./retryQueue";
import { atomicWriteFile } from "./atomicWrite";

// Poll for a state instead of sleeping a fixed window: fixed windows flake
// under load. The deadline only bounds a broken invariant.
async function until(cond: () => boolean, timeoutMs = 15_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-kit-rq-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

describe("classifiers", () => {
  it("parses rate limit delays", () => {
    expect(parseRateLimitDelay("please wait 30 seconds")).toBe(31000);
    expect(parseRateLimitDelay("Rate limit exceeded")).toBe(15000);
    expect(parseRateLimitDelay("boom")).toBeNull();
  });
  it("classifies network, overload, and ordinary errors", () => {
    expect(defaultClassifyError("fetch failed")).toBe("network");
    expect(defaultClassifyError("ECONNREFUSED 127.0.0.1")).toBe("network");
    expect(defaultClassifyError("Request timed out after 60000ms")).toBe("overload");
    expect(defaultClassifyError("Try again later")).toBe("overload");
    expect(defaultClassifyError("Invalid argument")).toBe("retry");
  });
});

describe("RetryQueue", () => {
  let queue: RetryQueue<any>;
  let logs: string[];
  beforeEach(() => {
    logs = [];
    queue = new RetryQueue({ initialDelayMs: 20, maxDelayMs: 200, maxAttempts: 3, onLog: (m) => logs.push(m) });
  });
  afterEach(() => queue.stop());

  it("adds operations", () => {
    const id = queue.add("send", { content: "t" });
    expect(id).toMatch(/^send-/);
    expect(queue.getQueueSize()).toBe(1);
    expect(logs).toContain(`Queued send for retry (id: ${id})`);
  });

  it("executes after the delay and removes on success", async () => {
    let ran = 0;
    queue.setExecutor(async () => { ran++; return true; });
    queue.add("send", {});
    expect(ran).toBe(0);
    await until(() => queue.getQueueSize() === 0);
    expect(ran).toBe(1);
  });

  it("retries with exponential backoff until success", async () => {
    let attempts = 0;
    queue.setExecutor(async () => { attempts++; if (attempts < 3) throw new Error("Server error 500"); return true; });
    queue.add("send", {});
    await until(() => queue.getQueueSize() === 0);
    expect(attempts).toBe(3);
    expect(logs.some((l) => l.includes("Next retry in 40ms"))).toBe(true);
  });

  it("drops an ordinary failure at maxAttempts and logs it", async () => {
    const dropped = tmpFile("dropped.json");
    queue = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2, droppedPath: dropped, onLog: (m) => logs.push(m) });
    queue.setExecutor(async () => { throw new Error("Invalid argument"); });
    queue.add("send", { k: 1 });
    await until(() => queue.getQueueSize() === 0);
    expect(queue.getDroppedOperations()).toHaveLength(1);
    expect(queue.getDroppedOperations()[0]).toMatchObject({ type: "send", attempts: 2, params: { k: 1 } });
    expect(queue.getDroppedOperationCount()).toBe(1);
    expect(logs.some((l) => l.startsWith("Max retries reached. DROPPED"))).toBe(true);
  });

  it("never drops a network error at maxAttempts", async () => {
    let attempts = 0;
    queue = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2, transientMaxDelayMs: 10, onLog: (m) => logs.push(m) });
    queue.setExecutor(async () => { attempts++; if (attempts < 5) throw new Error("fetch failed"); return true; });
    queue.add("send", {});
    await until(() => queue.getQueueSize() === 0);
    expect(attempts).toBe(5);
  });

  it("drops a permanent failure on the first attempt", async () => {
    queue = new RetryQueue({
      initialDelayMs: 5, maxAttempts: 5,
      classifyError: (e) => (e.includes("not found") ? "permanent" : "retry"),
      onLog: (m) => logs.push(m),
    });
    let attempts = 0;
    queue.setExecutor(async () => { attempts++; throw new Error("Conversation not found"); });
    queue.add("send", {});
    await until(() => queue.getQueueSize() === 0);
    expect(attempts).toBe(1);
    expect(logs.some((l) => l.includes("permanent failure"))).toBe(true);
  });

  it("honors a rate limit globally", async () => {
    const times: number[] = [];
    queue = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 5, onLog: (m) => logs.push(m) });
    let first = true;
    queue.setExecutor(async () => { times.push(Date.now()); if (first) { first = false; throw new Error("please wait 1 seconds"); } return true; });
    queue.add("a", {});
    queue.add("b", {});
    await until(() => queue.getQueueSize() === 0, 20_000);
    expect(logs.some((l) => l.includes("Rate limited globally for 2000ms"))).toBe(true);
    // After the first failure, everything waits out the hold (~2s).
    const sorted = [...times].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual(1900);
  });

  it("serializes operations sharing a key and runs others in parallel", async () => {
    let inflight = 0;
    let maxSameKey = 0;
    let maxTotal = 0;
    const perKey = new Map<string, number>();
    queue = new RetryQueue<{ key: string }>({
      initialDelayMs: 5, concurrency: 10,
      serialKey: (op) => op.params.key,
    });
    queue.setExecutor(async (op) => {
      inflight++;
      perKey.set(op.params.key, (perKey.get(op.params.key) ?? 0) + 1);
      maxSameKey = Math.max(maxSameKey, perKey.get(op.params.key)!);
      maxTotal = Math.max(maxTotal, inflight);
      await new Promise((r) => setTimeout(r, 30));
      perKey.set(op.params.key, perKey.get(op.params.key)! - 1);
      inflight--;
      return true;
    });
    for (let i = 0; i < 4; i++) queue.add("x", { key: "A" });
    for (let i = 0; i < 4; i++) queue.add("x", { key: "B" });
    await until(() => queue.getQueueSize() === 0);
    expect(maxSameKey).toBe(1);
    expect(maxTotal).toBeGreaterThanOrEqual(2);
  });

  it("caps concurrency", async () => {
    let inflight = 0, max = 0;
    queue = new RetryQueue({ initialDelayMs: 5, concurrency: 2 });
    queue.setExecutor(async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 20)); inflight--; return true; });
    for (let i = 0; i < 6; i++) queue.add("x", {});
    await until(() => queue.getQueueSize() === 0);
    expect(max).toBe(2);
  });

  it("collapses backoff on recovery without zeroing attempts", async () => {
    queue = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 60_000, maxAttempts: 10, onLog: (m) => logs.push(m) });
    let fail = true;
    const attemptsById = new Map<string, number>();
    queue.setExecutor(async (op) => {
      attemptsById.set(op.id, op.attempts);
      if (op.type === "slow" && fail) throw new Error("Server error");
      return true;
    });
    const slow = queue.add("slow", {});
    await until(() => (attemptsById.get(slow) ?? 0) >= 2);
    // The slow op is now parked on a long backoff. One success pulls it forward.
    fail = false;
    queue.add("fast", {});
    await until(() => queue.getQueueSize() === 0, 5000);
    expect(logs.some((l) => l.includes("collapsed backoff on 1 queued op"))).toBe(true);
    expect(attemptsById.get(slow)).toBeGreaterThanOrEqual(3);
  });

  it("notifyConnectionRestored pulls retries forward", async () => {
    queue = new RetryQueue({ initialDelayMs: 60_000 });
    let ran = false;
    queue.setExecutor(async () => { ran = true; return true; });
    queue.add("x", {});
    queue.notifyConnectionRestored();
    await until(() => ran);
  });

  it("onFailure hook can take over (replace)", async () => {
    let splits = 0;
    queue = new RetryQueue<{ n: number }>({
      initialDelayMs: 5, maxAttempts: 3,
      onFailure: (op, _err, q) => {
        if (op.params.n <= 1) return false;
        splits++;
        const half = Math.floor(op.params.n / 2);
        q.replace([op.id], [q.buildOperation(op.type, { n: half }), q.buildOperation(op.type, { n: op.params.n - half })]);
        return true;
      },
    });
    queue.setExecutor(async (op) => { if (op.params.n > 1) throw new Error("too big"); return true; });
    queue.add("batch", { n: 4 });
    await until(() => queue.getQueueSize() === 0);
    expect(splits).toBe(3);
  });

  it("persists, restores with onRestore, and heals the file", async () => {
    const file = tmpFile("queue.json");
    const q1 = new RetryQueue({ persistPath: file, persistDebounceMs: 1 });
    q1.add("a", { v: 1 });
    q1.add("b", { v: 2 });
    await until(() => fs.existsSync(file));
    q1.stop();
    const restored: string[] = [];
    const q2 = new RetryQueue({
      persistPath: file,
      onLog: (m) => restored.push(m),
      onRestore: (ops) => ops.filter((o) => o.type !== "b"),
    });
    expect(q2.getQueueSize()).toBe(1);
    expect(restored[0]).toContain("Restored 1 operations from disk (healed 2 -> 1)");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toHaveLength(1);
    q2.stop();
  });

  it("health and inspection helpers", () => {
    queue = new RetryQueue<{ c: string }>({ serialKey: (op) => op.params.c, now: () => 5000 });
    queue.add("x", { c: "one" });
    queue.add("x", { c: "one" });
    queue.add("x", { c: "two" });
    const h = queue.getHealth();
    expect(h).toEqual({ ops: 3, keys: 2, oldestPendingMs: 0 });
    expect(queue.hasPending((op) => op.params.c === "two")).toBe(true);
    expect(queue.getPendingOperations()).toHaveLength(3);
    queue.clear();
    expect(queue.getQueueSize()).toBe(0);
  });

  it("dropped log: count without a full parse, retention, and cap", async () => {
    const p = tmpFile("dropped.json");
    const DAY = 24 * 60 * 60 * 1000;
    // Seed an old entry by hand (pretty printed, like the writer does).
    fs.writeFileSync(p, JSON.stringify([{ id: "old", type: "x", params: { brace: "{ not an entry }" }, attempts: 1, createdAt: 0, droppedAt: Date.now() - 8 * DAY }], null, 2));
    const q = new RetryQueue({ initialDelayMs: 5, maxAttempts: 1, droppedPath: p });
    expect(q.getDroppedOperationCount()).toBe(1);
    q.setExecutor(async () => { throw new Error("Invalid"); });
    q.add("x", { nested: { brace: "{" } });
    await until(() => q.getQueueSize() === 0 && q.getDroppedOperations().length === 1);
    q.stop();
    expect(q.getDroppedOperations()[0].id).not.toBe("old");
    expect(q.getDroppedOperationCount()).toBe(1);
    q.clearDroppedOperations();
    expect(q.getDroppedOperationCount()).toBe(0);
  });
});

describe("atomicWriteFile", () => {
  it("publishes whole content, keeps mode, follows symlinks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-kit-aw-"));
    tempDirs.push(dir);
    const real = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    atomicWriteFile(real, "one", { mode: 0o644 });
    fs.symlinkSync(real, link);
    atomicWriteFile(link, "two");
    expect(fs.readFileSync(real, "utf-8")).toBe("two");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(real).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });
  it("defaults a new file to 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-kit-aw-"));
    tempDirs.push(dir);
    const f = path.join(dir, "sub", "secret");
    atomicWriteFile(f, "s");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("product supplied drops", () => {
  it("an onFailure hook can shed an operation with its own wording", async () => {
    const logs: string[] = [];
    const droppedPath = tmpFile("dropped.json");
    const q = new RetryQueue({
      initialDelayMs: 10,
      droppedPath,
      onLog: (m) => logs.push(m),
      onFailure: (op, error, queue) => {
        if (!error.includes("gone")) return false;
        queue.drop(op, `DROPPED ${op.type}: the target is gone (${error})`, "warn");
        return true;
      },
    });
    q.setExecutor(async () => {
      throw new Error("the row is gone");
    });
    q.add("write", { id: "a" });
    await until(() => q.getQueueSize() === 0);
    expect(logs.some((l) => l.startsWith("DROPPED write: the target is gone"))).toBe(true);
    expect(q.getDroppedOperations().map((d) => d.type)).toEqual(["write"]);
    q.stop();
  });

  it("dropContext names the product's own identifier on every drop line", async () => {
    const logs: string[] = [];
    const q = new RetryQueue<{ sessionId?: string }>({
      initialDelayMs: 10,
      maxAttempts: 1,
      onLog: (m) => logs.push(m),
      dropContext: (op) => `. Session: ${op.params.sessionId ?? "unknown"}`,
    });
    q.setExecutor(async () => {
      throw new Error("Validation error");
    });
    q.add("write", { sessionId: "s-42" });
    await until(() => q.getQueueSize() === 0);
    expect(logs.some((l) => l.startsWith("Max retries reached. DROPPED: write") && l.endsWith(". Session: s-42"))).toBe(true);
    q.stop();
  });

  it("droppedFields adds the product's own columns to the dropped log entry", async () => {
    const droppedPath = tmpFile("dropped.json");
    const q = new RetryQueue<{ sessionId?: string }>({
      initialDelayMs: 10,
      maxAttempts: 1,
      droppedPath,
      onLog: () => {},
      droppedFields: (op) => ({ sessionId: op.params.sessionId }),
    });
    q.setExecutor(async () => {
      throw new Error("Validation error");
    });
    q.add("write", { sessionId: "s-42" });
    await until(() => q.getQueueSize() === 0);
    const onDisk = JSON.parse(fs.readFileSync(droppedPath, "utf-8"));
    expect(onDisk[0].sessionId).toBe("s-42");
    expect(onDisk[0].droppedAt).toBeGreaterThan(0);
    q.stop();
  });
});

describe("persistNow", () => {
  it("is debounced by default and synchronous on request", () => {
    const persistPath = tmpFile("queue.json");
    const q = new RetryQueue({ persistPath, persistDebounceMs: 10_000, onLog: () => {} });
    q.add("write", { id: "a" });
    expect(fs.existsSync(persistPath)).toBe(false);
    q.persistNow();
    expect(fs.existsSync(persistPath)).toBe(false);
    q.persistNow({ sync: true });
    expect(JSON.parse(fs.readFileSync(persistPath, "utf-8"))).toHaveLength(1);
    q.stop();
  });
});

describe("atomicWriteFile diagnostics", () => {
  it("names the target, not the temp path, when the target is a directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-kit-aw-"));
    tempDirs.push(dir);
    const blocked = path.join(dir, "blocked");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "child"), "keeps the dir non-empty");
    expect(() => atomicWriteFile(blocked, "payload")).toThrow(
      new RegExp(`cannot publish ${blocked}.*not a directory, and that ${dir} is writable`, "s"),
    );
  });

  it("refuses a symlink loop and says how to break it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-kit-aw-"));
    tempDirs.push(dir);
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(() => atomicWriteFile(a, "x")).toThrow(/symlink loop.*repoint or delete/s);
  });
});

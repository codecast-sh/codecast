import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RetryQueue } from "./retryQueue.js";

// dropped-operations.json is a forensics log, not a ledger: nothing reads it back
// except the hourly health report, which needs a COUNT. Found 2026-08-15: a 4.4MB
// file of 666 drops last written in July, re-parsed synchronously on the daemon's
// main thread every hour and never cleared. These tests pin the two fixes — the
// count is derived without materializing the JSON, and stale entries age out.

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
function droppedPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dropped-ops-"));
  tempDirs.push(dir);
  return path.join(dir, "dropped-operations.json");
}

const DAY = 24 * 60 * 60 * 1000;

describe("RetryQueue dropped-operations file", () => {
  it("count matches the parsed length without a full parse, and is 0 for a missing file", async () => {
    const p = droppedPath();
    const q = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 1, droppedPath: p, onLog: () => {} });
    expect(q.getDroppedOperationCount()).toBe(0);

    q.setExecutor(async () => { throw new Error("Invalid argument: field required"); });
    for (let i = 0; i < 3; i++) q.add("addMessage", { content: `m${i}`, nested: { brace: "{ not an entry }" } });
    await until(() => q.getQueueSize() === 0 && q.getDroppedOperations().length === 3);
    q.stop();

    // params carrying "{" text must not inflate the count — only top-level entries.
    expect(q.getDroppedOperationCount()).toBe(3);
    expect(q.getDroppedOperationCount()).toBe(q.getDroppedOperations().length);
  });

  it("prunes entries older than the retention window on the next write", async () => {
    const p = droppedPath();
    const now = Date.now();
    const seed = [
      { id: "old-1", type: "addMessages", params: {}, attempts: 3, createdAt: now - 40 * DAY, droppedAt: now - 30 * DAY },
      { id: "old-2", type: "addMessages", params: {}, attempts: 3, createdAt: now - 20 * DAY, droppedAt: now - 8 * DAY },
      { id: "recent", type: "addMessages", params: {}, attempts: 3, createdAt: now - 2 * DAY, droppedAt: now - 1 * DAY },
    ];
    fs.writeFileSync(p, JSON.stringify(seed, null, 2));

    const q = new RetryQueue({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 1, droppedPath: p, onLog: () => {} });
    expect(q.getDroppedOperationCount()).toBe(3); // untouched until something is written

    q.setExecutor(async () => { throw new Error("Not found"); });
    q.add("addMessage", { content: "fresh" });
    await until(() => q.getQueueSize() === 0 && q.getDroppedOperationCount() !== 3);
    q.stop();

    const ids = q.getDroppedOperations().map((d) => d.id);
    expect(ids).toContain("recent");
    expect(ids.some((id) => id.startsWith("addMessage-"))).toBe(true);
    expect(ids).not.toContain("old-1");
    expect(ids).not.toContain("old-2");
    expect(q.getDroppedOperationCount()).toBe(2);
  });
});

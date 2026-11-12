import { describe, it, expect } from "bun:test";
import { WriteBudgetBackoff, isWriteBudgetRefusal } from "./writeBudgetBackoff.js";
import { SyncService } from "./syncService.js";

const REFUSAL = "[Request ID: x] Server Error\nToo many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second.";

describe("WriteBudgetBackoff", () => {
  it("recognizes only the deployment's write-budget refusal", () => {
    expect(isWriteBudgetRefusal(new Error(REFUSAL))).toBe(true);
    expect(isWriteBudgetRefusal(new Error("Documents read from or written to the \"conversations\" table changed"))).toBe(false);
    expect(isWriteBudgetRefusal(undefined)).toBe(false);
  });

  it("grows the pause while refusals keep coming, caps it, and resets after a quiet minute", () => {
    const b = new WriteBudgetBackoff(() => 1);
    expect(b.waitMs(0)).toBe(0);
    expect(b.refused(0)).toBe(2_000);
    expect(b.refused(2_000)).toBe(4_000);
    expect(b.refused(6_000)).toBe(8_000);
    for (let t = 14_000; t < 60_000; t += 1_000) b.refused(t);
    expect(b.waitMs(59_000)).toBe(30_000);
    expect(b.waitMs(200_000)).toBe(0);
    expect(b.refused(200_000)).toBe(2_000);
  });

  it("jitters the pause between half and all of its ceiling", () => {
    expect(new WriteBudgetBackoff(() => 0).refused(0)).toBe(1_000);
  });
});

describe("SyncService write-budget pause", () => {
  it("holds the next throttled write after a refusal, and does not pause unthrottled ones", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    const calls: string[] = [];
    let refuse = true;
    (sync as any).client = {
      mutation: async (name: string) => {
        calls.push(name);
        if (refuse) { refuse = false; throw new Error(REFUSAL); }
        return null;
      },
    };
    (sync as any).writeBudget = new WriteBudgetBackoff(() => 0); // 1s pause
    await expect((sync as any).mutate("users:daemonHeartbeat", {})).rejects.toThrow(/Too many writes/);
    const start = Date.now();
    await (sync as any).mutate("users:daemonHeartbeat", {});
    expect(Date.now() - start).toBeLessThan(200);
    await (sync as any).throttle();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });
});

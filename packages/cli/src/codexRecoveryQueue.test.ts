import { describe, expect, test } from "bun:test";
import { CodexRecoveryQueue } from "./codexRecoveryQueue.js";

describe("CodexRecoveryQueue", () => {
  test("delivery loads only its requested conversation and releases the demand after recovery", async () => {
    const demands: string[][] = [];
    const queue = new CodexRecoveryQueue(async (requested) => { demands.push([...requested]); }, () => {}, () => {});
    queue.request(true);
    await queue.wait();
    await queue.demand("saved-idle-thread");
    queue.request();
    await queue.wait();
    expect(demands).toEqual([[], ["saved-idle-thread"], []]);
  });

  test("delivery arriving during a sweep gets another pass before it returns", async () => {
    let finish!: () => void;
    const old = new Promise<void>((resolve) => { finish = resolve; });
    const demands: string[][] = [];
    const queue = new CodexRecoveryQueue(async (requested) => {
      demands.push([...requested]);
      if (demands.length === 1) await old;
    }, () => {}, () => {});
    queue.request();
    await Promise.resolve();
    const delivery = queue.demand("requested-later");
    finish();
    await delivery;
    expect(demands).toEqual([[], ["requested-later"]]);
  });

  test("reruns recovery for a new process after the old pass fails", async () => {
    let rejectOld!: (error: Error) => void;
    const oldPass = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    const events: string[] = [];
    let runs = 0;
    const queue = new CodexRecoveryQueue(
      () => {
        runs++;
        events.push(`recover-${runs}`);
        return runs === 1 ? oldPass : Promise.resolve();
      },
      () => events.push("clear-retry"),
      () => events.push("old-pass-failed"),
    );

    queue.request();
    await Promise.resolve();
    queue.request(true); // replacement ready while the old process is recovering
    const finished = queue.wait();
    rejectOld(new Error("old process closed"));
    await finished;

    expect(events).toEqual(["recover-1", "old-pass-failed", "clear-retry", "recover-2"]);
    expect(runs).toBe(2);
  });

  test("coalesces concurrent ready events into one recovery pass", async () => {
    let runs = 0;
    let clears = 0;
    const queue = new CodexRecoveryQueue(
      async () => { runs++; },
      () => { clears++; },
      () => {},
    );
    queue.request(true);
    queue.request(true);
    await queue.wait();
    expect(runs).toBe(1);
    expect(clears).toBe(1);
  });
});

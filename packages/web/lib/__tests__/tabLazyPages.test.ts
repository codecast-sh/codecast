import { describe, expect, test } from "bun:test";
import {
  lazyPage,
  loadPage,
  scheduleTabRouteWarmup,
  type LazyPageRecovery,
  type TabRouteWarmupScheduler,
} from "../tabLazyPages";

function createScheduler() {
  let hidden = false;
  let visibilityListener = () => {};
  let timerListener = () => {};
  let timerDelay = 0;
  let visibilityCancelled = 0;
  let timerCancelled = 0;
  const scheduler: TabRouteWarmupScheduler = {
    isHidden: () => hidden,
    onVisibilityChange(listener) {
      visibilityListener = listener;
      return () => visibilityCancelled++;
    },
    setTimer(listener, delayMs) {
      timerListener = listener;
      timerDelay = delayMs;
      return () => timerCancelled++;
    },
  };
  return {
    scheduler,
    hide() {
      hidden = true;
      visibilityListener();
    },
    fireTimer: () => timerListener(),
    stats: () => ({ timerDelay, visibilityCancelled, timerCancelled }),
  };
}

describe("scheduleTabRouteWarmup", () => {
  test("waits for a hidden window and warms once", async () => {
    let loads = 0;
    lazyPage("test-hidden-warmup", async () => {
      loads++;
      return { default: () => null };
    });
    const host = createScheduler();
    scheduleTabRouteWarmup(host.scheduler);

    expect(loads).toBe(0);
    expect(host.stats().timerDelay).toBe(60_000);
    host.hide();
    await Promise.resolve();
    host.fireTimer();
    await Promise.resolve();

    expect(loads).toBe(1);
    expect(host.stats()).toEqual({
      timerDelay: 60_000,
      visibilityCancelled: 1,
      timerCancelled: 1,
    });
  });

  test("warms after one minute when the window stays visible", async () => {
    let loads = 0;
    lazyPage("test-timer-warmup", async () => {
      loads++;
      return { default: () => null };
    });
    const host = createScheduler();
    scheduleTabRouteWarmup(host.scheduler);
    host.fireTimer();
    await Promise.resolve();

    expect(loads).toBe(1);
  });
});

describe("loadPage", () => {
  const page = { default: () => null };
  const chunkError = () => new TypeError("Failed to fetch dynamically imported module: /app/inbox/page.tsx?t=1");

  function createRecovery(plan: { updates: boolean[]; reimports: Array<"ok" | "fail"> }) {
    const calls = { waits: 0, reimports: [] as string[], timeouts: [] as number[] };
    const recovery: LazyPageRecovery = {
      async waitForUpdate(timeoutMs) {
        calls.timeouts.push(timeoutMs);
        calls.waits++;
        return plan.updates.shift() ?? false;
      },
      async reimport(key) {
        calls.reimports.push(key);
        const next = plan.reimports.shift();
        if (next === "ok") return page;
        throw chunkError();
      },
    };
    return { recovery, calls };
  }

  test("retries once right away and heals without waiting", async () => {
    const { recovery, calls } = createRecovery({ updates: [], reimports: ["ok"] });
    const loaded = await loadPage("@/app/inbox/page", async () => { throw chunkError(); }, recovery, 20_000);
    expect(loaded).toBe(page);
    expect(calls).toEqual({ waits: 0, reimports: ["@/app/inbox/page"], timeouts: [] });
  });

  test("retries after each dev server update until the page loads", async () => {
    const { recovery, calls } = createRecovery({ updates: [true, true], reimports: ["fail", "fail", "ok"] });
    let clock = 1_000;
    const loaded = await loadPage("@/app/inbox/page", async () => { throw chunkError(); }, recovery, 20_000, () => (clock += 100));
    expect(loaded).toBe(page);
    expect(calls.waits).toBe(2);
    expect(calls.reimports).toHaveLength(3);
    // Each wait gets only the time left in the window.
    expect(calls.timeouts[0]).toBeLessThan(20_000);
    expect(calls.timeouts[1]).toBeLessThan(calls.timeouts[0]);
  });

  test("gives up with the last rejection when no update arrives in the window", async () => {
    const { recovery, calls } = createRecovery({ updates: [false], reimports: ["fail"] });
    const last = chunkError();
    recovery.reimport = async () => { throw last; };
    await expect(loadPage("@/app/inbox/page", async () => { throw chunkError(); }, recovery, 20_000)).rejects.toBe(last);
    expect(calls.waits).toBe(1);
  });

  test("stops at the deadline even while updates keep coming", async () => {
    const { recovery, calls } = createRecovery({ updates: [true, true, true, true], reimports: ["fail", "fail", "fail", "fail", "fail"] });
    let clock = 0;
    await expect(
      loadPage("@/app/inbox/page", async () => { throw chunkError(); }, recovery, 1_000, () => (clock += 600)),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls.reimports.length).toBeLessThanOrEqual(2);
  });

  test("rethrows a page's own error without retrying", async () => {
    const { recovery, calls } = createRecovery({ updates: [true], reimports: ["ok"] });
    const bug = new TypeError("x is not a function");
    await expect(loadPage("@/app/inbox/page", async () => { throw bug; }, recovery, 20_000)).rejects.toBe(bug);
    expect(calls).toEqual({ waits: 0, reimports: [], timeouts: [] });
  });

  test("rethrows when there is no dev server to wait on", async () => {
    const err = chunkError();
    await expect(loadPage("@/app/inbox/page", async () => { throw err; }, null, 20_000)).rejects.toBe(err);
  });
});

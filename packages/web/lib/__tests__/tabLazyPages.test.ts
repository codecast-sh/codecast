import { describe, expect, test } from "bun:test";
import {
  lazyPage,
  scheduleTabRouteWarmup,
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

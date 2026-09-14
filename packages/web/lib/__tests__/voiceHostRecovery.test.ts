import { describe, expect, it } from "bun:test";
import {
  VOICE_HOST_QUIET_MS,
  VOICE_HOST_RELOAD_MAX_MS,
  VOICE_HOST_RELOAD_MIN_MS,
  voiceHostReloadPlan,
} from "../voiceHostRecovery";

describe("voiceHostReloadPlan", () => {
  it("reloads quickly after a first crash", () => {
    const { delayMs, next } = voiceHostReloadPlan(null, 1_000);
    expect(delayMs).toBe(VOICE_HOST_RELOAD_MIN_MS);
    expect(next).toEqual({ count: 0, at: 1_000 });
  });

  it("doubles the wait for crashes that follow closely, up to the cap", () => {
    let prev = voiceHostReloadPlan(null, 0).next;
    const delays: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const plan = voiceHostReloadPlan(prev, i * 10_000);
      delays.push(plan.delayMs);
      prev = plan.next;
    }
    expect(delays).toEqual([6_000, 12_000, 24_000, 48_000, VOICE_HOST_RELOAD_MAX_MS, VOICE_HOST_RELOAD_MAX_MS]);
  });

  it("starts over once the host has run quietly", () => {
    const prev = { count: 4, at: 0 };
    const { delayMs, next } = voiceHostReloadPlan(prev, VOICE_HOST_QUIET_MS);
    expect(delayMs).toBe(VOICE_HOST_RELOAD_MIN_MS);
    expect(next.count).toBe(0);
  });
});

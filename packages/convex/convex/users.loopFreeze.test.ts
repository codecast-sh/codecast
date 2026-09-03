// The loop-freeze SLO rides the same per-device write throttle as every other
// heartbeat field, so the claim "reporting freeze does not churn the roster"
// rests entirely on deviceBeatChanged plus the daemon rounding the values
// before it sends them. A raw millisecond hour total would move on every 30s
// beat and rewrite the device row, re-running every listDevices subscription
// in the fleet.
import { describe, expect, test } from "bun:test";
import { deviceBeatChanged } from "./users";

describe("loop freeze fields and the device write throttle", () => {
  const existing = {
    platform: "darwin",
    status: "online",
    last_seen: 1_700_000_000_000,
    loop_freeze_ms: 0,
    loop_freeze_1h_ms: 215_000,
    loop_freeze_max_ms: 42_000,
    loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
  };
  const beat = (over: Record<string, unknown> = {}) => ({
    platform: "darwin",
    status: "online" as const,
    last_seen: 1_700_000_030_000,
    loop_freeze_ms: 0,
    loop_freeze_1h_ms: 215_000,
    loop_freeze_max_ms: 42_000,
    loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
    ...over,
  });

  test("a repeated rounded hour total is not a change", () => {
    expect(deviceBeatChanged(existing, beat())).toBe(false);
  });

  test("one 5s step of the hour total is a change", () => {
    expect(deviceBeatChanged(existing, beat({ loop_freeze_1h_ms: 220_000 }))).toBe(true);
  });

  test("a new worst freeze or a new top cause is a change", () => {
    expect(deviceBeatChanged(existing, beat({ loop_freeze_max_ms: 61_000 }))).toBe(true);
    expect(deviceBeatChanged(existing, beat({ loop_freeze_top: "scanDir@daemon.ts:900 80%" }))).toBe(true);
  });

  test("a device that never reported the SLO writes through on its first report", () => {
    const { loop_freeze_1h_ms, loop_freeze_max_ms, loop_freeze_top, ...older } = existing;
    expect(deviceBeatChanged(older, beat())).toBe(true);
  });
});

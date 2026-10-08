import { describe, expect, test } from "bun:test";
import { replayClock } from "./clock";

describe("the player's clock is the replay's clock", () => {
  // rp-39: the capture starts at t0 and runs 361 s (the page kept mutating
  // after the last thing the person did); the row and its timeline say 5:00.
  const t0 = 1_791_212_170_248;
  const rp39 = replayClock({ t0, replay: { duration_ms: 300_008 } }, { startTime: t0, totalTime: 361_115 });

  test("the total is the row's duration, not where the capture ends", () => {
    expect(rp39.duration).toBe(300_008);
    expect(rp39.toClock(361_115)).toBe(300_008);
    expect(rp39.endOffset).toBe(300_008);
  });

  test("a time maps to the same offset and back, and past the end lands on the end", () => {
    expect(rp39.toOffset(60_000)).toBe(60_000);
    expect(rp39.toClock(rp39.toOffset(60_000))).toBe(60_000);
    expect(rp39.toOffset(340_000)).toBe(300_008);
    expect(rp39.toOffset(-5)).toBe(0);
  });

  test("a capture that starts after the clock's zero is shifted by the gap", () => {
    const c = replayClock({ t0: 1_000, replay: { duration_ms: 90_000 } }, { startTime: 11_000, totalTime: 70_000 });
    expect(c.lead).toBe(10_000);
    expect(c.toClock(0)).toBe(10_000);
    expect(c.toOffset(10_000)).toBe(0);
    expect(c.toOffset(5_000)).toBe(0);
    // The capture ends at 80 s on the clock; the replay at 90 s.
    expect(c.toOffset(85_000)).toBe(70_000);
    expect(c.endOffset).toBe(70_000);
    expect(c.toClock(70_000)).toBe(80_000);
  });

  test("with no duration on the row the capture's end is the end", () => {
    const c = replayClock({ t0: 0, replay: { duration_ms: null } }, { startTime: 2_000, totalTime: 30_000 });
    expect(c.duration).toBe(32_000);
    expect(c.endOffset).toBe(30_000);
  });
});

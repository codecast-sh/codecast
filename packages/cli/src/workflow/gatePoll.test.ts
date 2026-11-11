import { describe, expect, test } from "bun:test";
import { GATE_POLL_FAST_MS, GATE_POLL_FAST_WINDOW_MS, GATE_POLL_SLOW_MS, HAND_POLL_FAST_MS, HAND_POLL_FAST_WINDOW_MS, HAND_POLL_SLOW_MS, gatePollIntervalMs, handPollIntervalMs } from "./runner";

describe("gate poll pacing", () => {
  test("fast while the person may still be at the card, slow once the gate has waited", () => {
    expect(gatePollIntervalMs(0)).toBe(GATE_POLL_FAST_MS);
    expect(gatePollIntervalMs(GATE_POLL_FAST_WINDOW_MS - 1)).toBe(GATE_POLL_FAST_MS);
    expect(gatePollIntervalMs(GATE_POLL_FAST_WINDOW_MS)).toBe(GATE_POLL_SLOW_MS);
    expect(gatePollIntervalMs(3 * 24 * 3_600_000)).toBe(GATE_POLL_SLOW_MS);
  });

  test("an explicit interval wins at any age", () => {
    expect(gatePollIntervalMs(0, 1)).toBe(1);
    expect(gatePollIntervalMs(GATE_POLL_FAST_WINDOW_MS * 10, 1)).toBe(1);
  });
});

describe("hand poll pacing", () => {
  test("fast while a hand may still fail to start, slow once it is working", () => {
    expect(handPollIntervalMs(0)).toBe(HAND_POLL_FAST_MS);
    expect(handPollIntervalMs(HAND_POLL_FAST_WINDOW_MS - 1)).toBe(HAND_POLL_FAST_MS);
    expect(handPollIntervalMs(HAND_POLL_FAST_WINDOW_MS)).toBe(HAND_POLL_SLOW_MS);
  });

  test("a 40-minute hand is read under 100 times, not 240", () => {
    let reads = 0;
    for (let t = 0; t < 40 * 60_000; t += handPollIntervalMs(t)) reads++;
    expect(reads).toBeLessThan(100);
  });

  test("an explicit interval wins at any age", () => {
    expect(handPollIntervalMs(HAND_POLL_FAST_WINDOW_MS * 10, 1)).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { GATE_POLL_FAST_MS, GATE_POLL_FAST_WINDOW_MS, GATE_POLL_SLOW_MS, gatePollIntervalMs } from "./runner";

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

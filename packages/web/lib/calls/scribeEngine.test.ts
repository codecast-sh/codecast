import { describe, expect, test } from "bun:test";
import {
  APPEND_RETRY_MAX,
  APPEND_RETRY_MAX_AGE_MS,
  flushDue,
  FLUSH_MIN_INTERVAL_MS,
  GAP_MS,
  MAX_HOLD_MS,
  settleFailedAppends,
  WORKING_HOLD_MS,
} from "./scribeEngine";

// The gap watcher's one rule. The server holds context for a busy agent
// anyway; this keeps the scribe from asking it to, once a second, for the
// length of a turn — while an ask still rides the next lull.
describe("flushDue", () => {
  const base = { sinceFlushMs: FLUSH_MIN_INTERVAL_MS, anySpeaking: false, quietForMs: GAP_MS, heldForMs: 5_000, busy: false, addressed: false };

  test("a lull flushes once the minimum interval has passed", () => {
    expect(flushDue(base)).toBe(true);
    expect(flushDue({ ...base, sinceFlushMs: FLUSH_MIN_INTERVAL_MS - 1 })).toBe(false);
    expect(flushDue({ ...base, quietForMs: GAP_MS - 1 })).toBe(false);
    expect(flushDue({ ...base, anySpeaking: true })).toBe(false);
    expect(flushDue({ ...base, quietForMs: null })).toBe(false);
  });

  test("words that waited the hold limit flush mid-conversation", () => {
    expect(flushDue({ ...base, anySpeaking: true, heldForMs: MAX_HOLD_MS })).toBe(true);
    expect(flushDue({ ...base, anySpeaking: true, heldForMs: MAX_HOLD_MS - 1 })).toBe(false);
  });

  test("every agent mid-turn and nobody named: only the long hold, never the lull", () => {
    expect(flushDue({ ...base, busy: true })).toBe(false);
    expect(flushDue({ ...base, busy: true, heldForMs: MAX_HOLD_MS })).toBe(false);
    expect(flushDue({ ...base, busy: true, heldForMs: WORKING_HOLD_MS })).toBe(true);
  });

  test("a line that names an agent restores the lull cadence while it works", () => {
    expect(flushDue({ ...base, busy: true, addressed: true })).toBe(true);
    expect(flushDue({ ...base, busy: true, addressed: true, anySpeaking: true, heldForMs: MAX_HOLD_MS })).toBe(true);
  });
});

// A refused append keeps its words for the next tick, under two bounds; past
// either the loss is counted so the engine can show it instead of hiding it.
describe("settleFailedAppends", () => {
  const f = (at: number, text: string) => ({ at, segment: text });

  test("fresh failures join the list and keep their first failure time", () => {
    const out = settleFailedAppends([f(1_000, "a")], [f(2_000, "b")], 3_000);
    expect(out).toEqual({ queue: [f(1_000, "a"), f(2_000, "b")], dropped: 0 });
  });

  test("words older than the age bound are given up on and counted", () => {
    const now = 100_000;
    const out = settleFailedAppends([f(now - APPEND_RETRY_MAX_AGE_MS, "old")], [f(now - 10, "new")], now);
    expect(out).toEqual({ queue: [f(now - 10, "new")], dropped: 1 });
  });

  test("the list never grows past the size bound; the oldest go first", () => {
    const queue = Array.from({ length: APPEND_RETRY_MAX }, (_, i) => f(1_000 + i, `q${i}`));
    const out = settleFailedAppends(queue, [f(5_000, "x"), f(5_001, "y")], 6_000);
    expect(out.queue).toHaveLength(APPEND_RETRY_MAX);
    expect(out.queue[0]).toEqual(f(1_002, "q2"));
    expect(out.queue[APPEND_RETRY_MAX - 1]).toEqual(f(5_001, "y"));
    expect(out.dropped).toBe(2);
  });
});

import { describe, expect, test } from "bun:test";
import { flushDue, FLUSH_MIN_INTERVAL_MS, GAP_MS, MAX_HOLD_MS, WORKING_HOLD_MS } from "./scribeEngine";

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

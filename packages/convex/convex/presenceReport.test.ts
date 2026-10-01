import { describe, expect, test } from "bun:test";
import {
  INPUT_ACTIVE_MS,
  PRESENCE_FRESH_MS,
  PRESENCE_INPUT_STEP_MS,
  PRESENCE_SEEN_REFRESH_MS,
  isDesktopActivePresence,
  presenceReportPatch,
} from "./presencePolicy";

// A presence report must write nothing when nothing a reader can see changed,
// because every write re-runs the team roster for every open tab. These pin
// both halves: the writes it skips, and the ones it must never skip.
const T = 1_800_000_000_000;
const row = (over: Partial<{ last_seen: number; last_input_at: number; focused: boolean }> = {}) => ({
  last_seen: T, last_input_at: T, focused: true, ...over,
});

describe("presenceReportPatch", () => {
  test("a repeat report seconds later writes nothing", () => {
    expect(presenceReportPatch(row(), { focused: true, lastInputAt: T + 10_000 }, T + 20_000)).toEqual({});
  });

  test("a first report writes the whole row", () => {
    expect(presenceReportPatch(null, { focused: false, lastInputAt: T - 5_000 }, T))
      .toEqual({ last_seen: T, last_input_at: T - 5_000, focused: false, updated_at: T });
  });

  test("last_seen refreshes once it is a minute old, long before the row reads as gone", () => {
    const now = T + PRESENCE_SEEN_REFRESH_MS;
    expect(presenceReportPatch(row(), { focused: true, lastInputAt: T }, now)).toEqual({ last_seen: now, updated_at: now });
    expect(PRESENCE_SEEN_REFRESH_MS + 30_000).toBeLessThan(PRESENCE_FRESH_MS);
  });

  test("input that moved 30 s forward is written, with last_seen", () => {
    const now = T + 40_000;
    const lastInputAt = T + PRESENCE_INPUT_STEP_MS;
    expect(presenceReportPatch(row(), { focused: true, lastInputAt }, now))
      .toEqual({ last_input_at: lastInputAt, last_seen: now, updated_at: now });
  });

  test("a focus change is written at once", () => {
    const patch = presenceReportPatch(row(), { focused: false, lastInputAt: T }, T + 1_000);
    expect(patch.focused).toBe(false);
    expect(patch.last_seen).toBe(T + 1_000);
  });

  test("input never moves backward", () => {
    expect(presenceReportPatch(row(), { focused: true, lastInputAt: T - 600_000 }, T + 5_000)).toEqual({});
  });

  test("returning from away is written on the first report, so routing sees the person at once", () => {
    const away = row({ last_input_at: T - 30 * 60_000 });
    const patch = presenceReportPatch(away, { focused: true, lastInputAt: T }, T + 1_000);
    expect(patch.last_input_at).toBe(T);
    expect(isDesktopActivePresence({ ...away, ...patch } as any, T + 1_000)).toBe(true);
  });

  test("the worst lag ends active at most 30 s early, toward away", () => {
    // Typed at T+29s, not written; the stored value is T. Active ends at
    // T + INPUT_ACTIVE_MS instead of T + 29s + INPUT_ACTIVE_MS.
    expect(presenceReportPatch(row(), { focused: true, lastInputAt: T + 29_000 }, T + 29_000)).toEqual({});
    expect(isDesktopActivePresence(row({ last_seen: T + INPUT_ACTIVE_MS - 1 }), T + INPUT_ACTIVE_MS - 1)).toBe(true);
    expect(PRESENCE_INPUT_STEP_MS).toBeLessThan(INPUT_ACTIVE_MS / 4);
  });
});

import { describe, expect, test } from "bun:test";
import {
  fallbackProfiles,
  isUsageExhausted,
  rankByHeadroom,
  switchUsagePercent,
  worstUsagePercent,
  type CcUsage,
} from "./usageLimits";

const now = 1_000_000_000_000;

function usage(partial: Partial<CcUsage> & { session?: CcUsage["session"]; weekly?: CcUsage["weekly"] }): CcUsage {
  return { fetched_at: now - 60_000, ...partial };
}

describe("switchUsagePercent", () => {
  test("matches worstUsagePercent on a fresh snapshot with future resets", () => {
    const snap = usage({
      session: { percent: 16, resets_at: now + 3600_000 },
      weekly: { percent: 42, resets_at: now + 86_400_000 },
      weekly_scoped: { percent: 77, resets_at: now + 86_400_000, label: "Fable" },
    });
    expect(switchUsagePercent(snap, now)).toBe(77);
    expect(worstUsagePercent(snap, now)).toBe(77);
  });

  test("a rolled window measured AFTER the reset is empty, not unknown", () => {
    const snap = usage({
      fetched_at: now - 10_000,
      session: { percent: 0, resets_at: now - 60_000 },
      weekly: { percent: 19, resets_at: now + 86_400_000 },
    });
    expect(switchUsagePercent(snap, now)).toBe(19);
  });

  test("a rolled window whose snapshot predates the reset is unknown", () => {
    // 6h-old probe, Fable reset 3h ago, leftover session 2% — display reads 2,
    // switch must not treat that as "most headroom".
    const snap: CcUsage = {
      fetched_at: now - 6 * 3600_000,
      session: { percent: 2, resets_at: now + 3600_000 },
      weekly: { percent: 54, resets_at: now - 3 * 3600_000 },
      weekly_scoped: { percent: 100, resets_at: now - 3 * 3600_000, label: "Fable" },
    };
    expect(worstUsagePercent(snap, now)).toBe(2);
    expect(switchUsagePercent(snap, now)).toBeNull();
    expect(isUsageExhausted(snap, now)).toBe(false);
  });
});

describe("rankByHeadroom", () => {
  test("known remaining Fable beats a stale rolled snapshot that displays as 2%", () => {
    const staleRolled = {
      name: "stale",
      email: "stale@x.com",
      usage: {
        fetched_at: now - 6 * 3600_000,
        session: { percent: 2, resets_at: now + 3600_000 },
        weekly: { percent: 54, resets_at: now - 3 * 3600_000 },
        weekly_scoped: { percent: 100, resets_at: now - 3 * 3600_000, label: "Fable" },
      } satisfies CcUsage,
    };
    const known = {
      name: "known",
      email: "known@x.com",
      usage: {
        fetched_at: now - 60_000,
        session: { percent: 0, resets_at: now + 3600_000 },
        weekly: { percent: 37, resets_at: now + 86_400_000 },
        weekly_scoped: { percent: 69, resets_at: now + 86_400_000, label: "Fable" },
      } satisfies CcUsage,
    };
    const ranked = rankByHeadroom([staleRolled, known], now);
    expect(ranked.map((p) => p.name)).toEqual(["known", "stale"]);
    const fallbacks = fallbackProfiles([staleRolled, known, { name: "active", email: "a@x.com" }], "a@x.com", now);
    expect(fallbacks.map((p) => p.name)).toEqual(["known", "stale"]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  CALIBRATION_SLOT_MS,
  MIN_PERCENT_DELTA,
  SAMPLE_WINDOW,
  calibrationSlot,
  foldSamples,
  medianOf,
  percentRise,
  windowReadingsOf,
} from "./usageCalibration";
import { rollUpUsage } from "./messages";
import {
  isCalibrated,
  reloadCostTokens,
  remainingWindowTokens,
  restartShareOfRemaining,
  weightedTokens,
} from "@codecast/shared/contracts";

const NOW = 1_800_000_000_000;

describe("the slot the numerator is counted in", () => {
  test("a slot is twenty minutes, and rollUpUsage stamps the one it billed in", async () => {
    const conv: any = { _id: "c1" };
    const patch: Record<string, unknown> = {};
    await rollUpUsage({ db: {} }, conv, [
      { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, api_message_id: "a", inserted: true },
    ], patch, NOW);
    const totals = patch.usage_totals as any;
    expect(totals.slot).toBe(calibrationSlot(NOW));
    // 100 + 0.1*1000 + 1.25*200 + 5*10 = 500
    expect(totals.slot_weighted).toBe(500);
  });

  test("a second turn in the same slot adds; the first turn of a new slot starts over", async () => {
    const conv: any = { _id: "c1", usage_totals: { input: 0, output: 0, cache_read: 0, cache_write: 0, updated_at: NOW, slot: calibrationSlot(NOW), slot_weighted: 500 } };
    const same: Record<string, unknown> = {};
    await rollUpUsage({ db: {} }, conv, [
      { usage: { input_tokens: 100, output_tokens: 0 }, api_message_id: "b", inserted: true },
    ], same, NOW + 60_000);
    expect((same.usage_totals as any).slot_weighted).toBe(600);

    const later: Record<string, unknown> = {};
    await rollUpUsage({ db: {} }, conv, [
      { usage: { input_tokens: 100, output_tokens: 0 }, api_message_id: "c", inserted: true },
    ], later, NOW + CALIBRATION_SLOT_MS);
    expect((later.usage_totals as any).slot).toBe(calibrationSlot(NOW) + 1);
    expect((later.usage_totals as any).slot_weighted).toBe(100);
  });
});

describe("the meters the denominator is read from", () => {
  const device = (profiles: any[]) => ({ cc_accounts: { profiles } });
  const profile = (email: string, percent: number, fetched_at = NOW, resets_at = NOW + 3_600_000) =>
    ({ name: email.split("@")[0], email, usage: { fetched_at, session: { percent, resets_at } } });

  test("one reading per account, freshest device wins", () => {
    const readings = windowReadingsOf([
      device([profile("a@x.com", 30, NOW - 60_000)]),
      device([profile("a@x.com", 34, NOW), profile("b@x.com", 10)]),
    ]);
    expect(readings.map((r) => [r.key, r.percent]).sort()).toEqual([["a@x.com", 34], ["b@x.com", 10]]);
  });

  test("an account with no session window is not a reading", () => {
    expect(windowReadingsOf([device([{ name: "n", email: "c@x.com", usage: { fetched_at: NOW } }])])).toEqual([]);
  });

  test("the rise sums every window that stayed in its own window and went up", () => {
    const before = [
      { key: "a", percent: 30, resets_at: 1 },
      { key: "b", percent: 80, resets_at: 2 },
      { key: "c", percent: 90, resets_at: 3 },
    ];
    const after = [
      { key: "a", percent: 38, resets_at: 1 }, // +8
      { key: "b", percent: 5, resets_at: 9 }, // rolled: a new window, not a fall
      { key: "c", percent: 92, resets_at: 3 }, // +2
      { key: "d", percent: 50, resets_at: 4 }, // no before reading
    ];
    expect(percentRise(before, after)).toBe(10);
  });

  test("a percent that fell inside the same window is not negative usage", () => {
    expect(percentRise([{ key: "a", percent: 40, resets_at: 1 }], [{ key: "a", percent: 31, resets_at: 1 }])).toBe(0);
  });
});

describe("the published rate", () => {
  test("the median is what gets published, so one odd slot cannot move it", () => {
    expect(medianOf([100, 110, 5000, 120])).toBe(115);
    expect(medianOf([])).toBeNull();
  });

  test("the sample window keeps only the most recent fits", () => {
    const many = Array.from({ length: SAMPLE_WINDOW + 10 }, (_, i) => i);
    const folded = foldSamples(many, [999]);
    expect(folded.recent.length).toBe(SAMPLE_WINDOW);
    expect(folded.recent[folded.recent.length - 1]).toBe(999);
  });

  test("a rise below the rounding floor is not a sample worth keeping", () => {
    // Guard on the constant itself: at one integer point the reading is ±50%.
    expect(MIN_PERCENT_DELTA).toBeGreaterThanOrEqual(4);
  });
});

describe("what a restart costs against the window", () => {
  const calibrated = { tokens_per_percent: 1_000_000, samples: 10, updated_at: NOW };
  const usage = (percent: number, resets_at = NOW + 3_600_000) =>
    ({ fetched_at: NOW, session: { percent, resets_at } });

  test("tokens are counted cost-weighted, and a reload is priced as a cache write", () => {
    expect(weightedTokens({ input: 100, cache_read: 1000, cache_write: 200, output: 10 })).toBe(500);
    expect(reloadCostTokens(400_000)).toBe(500_000);
  });

  test("remaining room is the unused percent at the measured rate", () => {
    expect(remainingWindowTokens(usage(30), calibrated, NOW)).toBe(70_000_000);
    expect(remainingWindowTokens(usage(100), calibrated, NOW)).toBe(0);
  });

  test("the share is the reload against what is left", () => {
    // 400k context → 500k weighted, against 70M of room.
    expect(restartShareOfRemaining(400_000, usage(30), calibrated, NOW)).toBeCloseTo(500_000 / 70_000_000, 10);
    // A window with nothing left: the restart is more than all of it.
    expect(restartShareOfRemaining(400_000, usage(100), calibrated, NOW)).toBe(Infinity);
  });

  test("an unfitted rate, a missing window or a rolled snapshot says nothing", () => {
    expect(isCalibrated({ tokens_per_percent: 500, samples: 1, updated_at: NOW })).toBe(false);
    expect(restartShareOfRemaining(400_000, usage(30), null, NOW)).toBeNull();
    expect(restartShareOfRemaining(400_000, { fetched_at: NOW }, calibrated, NOW)).toBeNull();
    // A window that rolled since the snapshot was taken is UNMEASURED, not
    // empty: the reading describes a window that no longer exists.
    expect(restartShareOfRemaining(400_000, { fetched_at: NOW - 600_000, session: { percent: 30, resets_at: NOW - 1 } }, calibrated, NOW)).toBeNull();
    // Re-probed after the reset, the same rolled stamp means a fresh window.
    expect(restartShareOfRemaining(400_000, usage(30, NOW - 1), calibrated, NOW)).toBeCloseTo(500_000 / 100_000_000, 10);
  });
});

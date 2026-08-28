import { describe, expect, test } from "bun:test";
import { isSyncGap } from "../docSyncCache";

// A CLI edit rebuilds the snapshot at a bumped version and deletes every
// delta. A client behind that point can fetch no steps, so it can never catch
// up by replay — the only signal that it must remount from the snapshot.
describe("isSyncGap", () => {
  test("server ahead and no steps to replay → gap", () => {
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2620 })).toBe(true);
  });

  test("server ahead but steps bridge it → not a gap (normal catch-up)", () => {
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2662 })).toBe(false);
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2640 })).toBe(false);
  });

  test("client at or ahead of server → not a gap", () => {
    expect(isSyncGap({ serverVersion: 2620, localVersion: 2620, stepsVersion: 2620 })).toBe(false);
    expect(isSyncGap({ serverVersion: 2600, localVersion: 2620, stepsVersion: 2620 })).toBe(false);
  });

  test("doc still being created (version ≤ 1) or unknown server → never a gap", () => {
    expect(isSyncGap({ serverVersion: 1, localVersion: 0, stepsVersion: 0 })).toBe(false);
    expect(isSyncGap({ serverVersion: null, localVersion: 5, stepsVersion: 5 })).toBe(false);
    expect(isSyncGap({ serverVersion: undefined, localVersion: 5, stepsVersion: 5 })).toBe(false);
  });
});

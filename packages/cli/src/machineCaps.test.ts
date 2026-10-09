import { describe, expect, test } from "bun:test";
import { checkWatchersForMemory, machineCap } from "./machineCaps.js";

const GB = 2 ** 30;

describe("typecheck watcher cap", () => {
  test("scales with memory, one watcher per 12 GB, within 2 to 16", () => {
    expect(checkWatchersForMemory(128 * GB)).toBe(10);
    expect(checkWatchersForMemory(64 * GB)).toBe(5);
    expect(checkWatchersForMemory(16 * GB)).toBe(2);
    expect(checkWatchersForMemory(512 * GB)).toBe(16);
  });

  test("the environment still wins over the default", () => {
    expect(machineCap("check", { CAST_CHECK_MAX_WATCHERS: "3" })).toBe(3);
  });
});

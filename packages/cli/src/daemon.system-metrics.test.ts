import { describe, expect, test } from "bun:test";
import { measureLoopHold } from "./test-helpers/loopHold.js";
import { getSystemMetrics, parseFootprintMb } from "./daemon.js";

describe("parseFootprintMb", () => {
  test("reads the phys_footprint line in any unit, rounded to MB", () => {
    expect(parseFootprintMb("phys_footprint: 1.5 GB\n")).toBe(1536);
    expect(parseFootprintMb("pid: 1\nphys_footprint: 119 MB\n")).toBe(119);
    expect(parseFootprintMb("phys_footprint: 512 KB")).toBe(1);
    expect(parseFootprintMb("nothing here")).toBeNull();
  });
});

describe("getSystemMetrics", () => {
  test("answers without holding the loop", async () => {
    const { result, maxGapMs } = await measureLoopHold(() => getSystemMetrics());
    expect(result.fds).toBeGreaterThan(0);
    expect(result.rss_mb).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(50);
  });
});

import { describe, expect, test } from "bun:test";
import { loopHoldBoundMs, measureLoopHold } from "./test-helpers/loopHold.js";
import { getSystemMetrics, parseFootprintMb, type SystemMetricsIO } from "./daemon.js";

describe("parseFootprintMb", () => {
  test("reads the phys_footprint line in any unit, rounded to MB", () => {
    expect(parseFootprintMb("phys_footprint: 1.5 GB\n")).toBe(1536);
    expect(parseFootprintMb("pid: 1\nphys_footprint: 119 MB\n")).toBe(119);
    expect(parseFootprintMb("phys_footprint: 512 KB")).toBe(1);
    expect(parseFootprintMb("nothing here")).toBeNull();
  });
});

describe("getSystemMetrics", () => {
  test("counts /dev/fd entries when the directory reads", async () => {
    const io: SystemMetricsIO = {
      readdir: async () => ["0", "1", "2", "3"],
      execFile: async () => { throw new Error("must not run lsof"); },
    };
    const m = await getSystemMetrics(io);
    expect(m.fds).toBe(4);
    expect(m.rss_mb).toBeGreaterThan(0);
  });

  // The lsof fallback is the slow branch, and it never runs where /dev/fd
  // exists: the fake stands in for a 30ms lsof so the wait is measured.
  test("falls back to lsof off the loop and counts its lines", async () => {
    let lsofArgs: string[] = [];
    let lsofOpts: { timeout: number; maxBuffer: number } | null = null;
    const io: SystemMetricsIO = {
      readdir: async () => { throw new Error("ENOENT"); },
      execFile: (_cmd, args, opts) => {
        lsofArgs = args;
        lsofOpts = opts;
        return new Promise((resolve) => setTimeout(() => resolve({ stdout: "COMMAND PID\nbun 1 cwd\nbun 1 txt\n" }), 30));
      },
    };
    const { result, ticks, maxGapMs } = await measureLoopHold(() => getSystemMetrics(io));
    expect(result.fds).toBe(3);
    expect(lsofArgs).toEqual(["-p", String(process.pid)]);
    expect(lsofOpts!.maxBuffer).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(maxGapMs).toBeLessThan(loopHoldBoundMs(50));
  });

  test("answers 0 fds when both primitives fail, never throws", async () => {
    const io: SystemMetricsIO = {
      readdir: async () => { throw new Error("ENOENT"); },
      execFile: async () => { throw new Error("maxBuffer exceeded"); },
    };
    expect((await getSystemMetrics(io)).fds).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import {
  admissionBudget, coldReservationBytes, DEFAULT_COLD_BYTES, budgetBytes, FLOOR_BYTES, footprintsOf, parseDarwinSysctl, parseFootprints, parseMeminfo, parseVmStat, peakOfPids, rssOfPids, fitsBudget, holdBytes, HISTORY, learnedSizes, peaksPath, percentile, readPeaks, recordPeak,
  reservationBytes, reserveBytes, treeRssBytes, watcherCeilingBytes, type Peak, type ProcTable,
} from "./watcherMemory.js";

const GB = 2 ** 30;
const clean = (gb: number, at = 1): Peak => ({ at, bytes: gb * GB, outcome: "clean" });
const oom = (gb: number): Peak => ({ at: 1, bytes: gb * GB, outcome: "oom" });

let iso: IsolatedCodecastDir;
beforeEach(() => { iso = isolateCodecastDir("cast-watcher-memory-"); });
afterEach(() => iso.restore());

describe("the reservation a new watcher makes", () => {
  const ceiling = 10 * GB;
  test("is the whole ceiling until three clean passes are known", () => {
    expect(reservationBytes([], ceiling)).toBe(ceiling);
    expect(reservationBytes([clean(2), clean(2)], ceiling)).toBe(ceiling);
  });

  test("is p95 of the clean peaks times 1.25 once warm", () => {
    expect(reservationBytes([clean(2), clean(4), clean(3)], ceiling)).toBe(5 * GB);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95)).toBe(19);
  });

  test("never drops under the floor nor rises over the ceiling", () => {
    expect(reservationBytes([clean(0.1), clean(0.1), clean(0.1)], ceiling)).toBe(FLOOR_BYTES);
    expect(reservationBytes([clean(9), clean(9), clean(9)], ceiling)).toBe(ceiling);
  });

  test("tsc hitting its own heap cap is recorded but neither resets the learning nor asks for the ceiling", () => {
    const heap: Peak = { at: 1, bytes: 8 * GB, outcome: "heap" };
    expect(reservationBytes([clean(2), clean(2), clean(2), heap], ceiling)).toBe(2.5 * GB);
    expect(reservationBytes([heap], ceiling, 5 * GB)).toBe(5 * GB);
  });

  test("a death by memory starts the learning over", () => {
    expect(reservationBytes([clean(2), clean(2), clean(2), oom(6), clean(2)], ceiling)).toBe(ceiling);
    expect(reservationBytes([clean(9), oom(6), clean(2), clean(2), clean(2)], ceiling)).toBe(2.5 * GB);
    // Even where admission caps an unmeasured project at half the budget, one that just died of memory gets the whole ceiling.
    expect(reservationBytes([clean(6), clean(6), clean(6), oom(7)], ceiling, 5 * GB)).toBe(ceiling);
    expect(reservationBytes([], ceiling, 5 * GB)).toBe(5 * GB);
  });

  test("the ceiling follows tsc's heap cap, raised when the asker raised it either way", () => {
    expect(watcherCeilingBytes({})).toBe(10 * GB);
    expect(watcherCeilingBytes({ CAST_CHECK_HEAP_MB: "16384" })).toBe(20 * GB);
    expect(watcherCeilingBytes({ NODE_OPTIONS: "--max-old-space-size=12288" })).toBe(15 * GB);
  });

  test("an unmeasured project reserves no more than half the budget; a measured one what it measured", () => {
    expect(reservationBytes([], 10 * GB, 5.6 * GB)).toBe(5.6 * GB);
    expect(reservationBytes([clean(6.7), clean(6.7), clean(6.7)], 10 * GB, 5.6 * GB)).toBe(Math.ceil(6.7 * GB * 1.25));
  });

  test("an unmeasured project is estimated from the projects this machine has measured, else 4 GB, never a flat ceiling", () => {
    // MacBook-Pro-182 on 2026-11-14: web 5.4, mobile 3.8, backend 6.4 learned; the median is web's.
    expect(coldReservationBytes(102.4 * GB, [5.4 * GB, 3.8 * GB, 6.4 * GB], {})).toBe(5.4 * GB);
    expect(coldReservationBytes(102.4 * GB, [], {})).toBe(DEFAULT_COLD_BYTES);
    // Never more than half the budget, nor under the floor.
    expect(coldReservationBytes(6 * GB, [], {})).toBe(3 * GB);
    expect(coldReservationBytes(0, [], {})).toBe(FLOOR_BYTES);
  });
});

describe("what a live watcher holds", () => {
  const ceiling = 10 * GB;
  test("a watcher still building its first pass holds what its project is expected to reach", () => {
    expect(holdBytes({}, 1 * GB, [], ceiling, 4 * GB)).toBe(4 * GB);
    expect(holdBytes({}, 1 * GB, [clean(5.4), clean(5.4), clean(5.4)], ceiling, 4 * GB)).toBe(5.4 * GB);
    expect(holdBytes({}, 6 * GB, [], ceiling, 4 * GB)).toBe(6 * GB);
  });
  test("a cold watcher that has finished a pass holds what it measures, or the peak it reached", () => {
    expect(holdBytes({ firstFinishedAt: 5 }, 3 * GB, [clean(3)], ceiling)).toBe(3 * GB);
    expect(holdBytes({ firstFinishedAt: 5, peakRssBytes: 5 * GB }, 2 * GB, [clean(3)], ceiling)).toBe(2 * GB);
    // A pass in flight climbs back toward the peak it reached.
    expect(holdBytes({ firstFinishedAt: 5, inProgress: true, peakRssBytes: 5 * GB }, 2 * GB, [clean(3)], ceiling)).toBe(5 * GB);
  });
  test("a watcher from before firstFinishedAt existed counts a finished pass by finishedAt", () => {
    expect(holdBytes({ finishedAt: 5 }, 3 * GB, [], ceiling)).toBe(3 * GB);
  });
  test("a watcher past its first pass holds its live use, not its project's p95 headroom", () => {
    const peaks = [clean(2), clean(2), clean(2)];
    expect(holdBytes({ firstFinishedAt: 5 }, 1 * GB, peaks, ceiling)).toBe(1 * GB);
    expect(holdBytes({ firstFinishedAt: 5, peakRssBytes: 1.5 * GB }, 1 * GB, peaks, ceiling)).toBe(1 * GB);
    expect(holdBytes({ firstFinishedAt: 5 }, 4 * GB, peaks, ceiling)).toBe(4 * GB);
  });
  test("one more fits when holds plus its need stay in budget; a machine always runs one", () => {
    expect(fitsBudget([4 * GB, 2 * GB], 3 * GB, 9 * GB)).toBe(true);
    expect(fitsBudget([4 * GB, 2 * GB], 3.5 * GB, 9 * GB)).toBe(false);
    expect(fitsBudget([], 50 * GB, 9 * GB)).toBe(true);
  });
});

describe("the budget", () => {
  test("is total memory minus a reserve: 8 GB or a fifth by default, else the env, else check.reserve_gb", () => {
    expect(reserveBytes(128 * GB, {})).toBe(Math.round(128 * GB * 0.2));
    expect(budgetBytes(128 * GB, {})).toBe(Math.round(128 * GB * 0.8));
    expect(reserveBytes(16 * GB, {})).toBe(8 * GB);
    expect(budgetBytes(64 * GB, { CAST_CHECK_RESERVE_GB: "40" })).toBe(24 * GB);
    expect(budgetBytes(16 * GB, { CAST_CHECK_RESERVE_GB: "20" })).toBe(0);
    fs.writeFileSync(`${iso.dir}/config.json`, JSON.stringify({ check: { reserve_gb: 48 } }));
    expect(budgetBytes(64 * GB, {})).toBe(16 * GB);
  });
});

describe("the record of peaks", () => {
  test("is kept per (repo, project), shared by the repo's worktrees, and cut back to the window", () => {
    for (let i = 0; i < HISTORY + 400; i++) recordPeak("/src/repo", "web", { at: i, bytes: (i + 1) * 1024, outcome: "clean", root: "/src/repo/.wt/a" });
    recordPeak("/src/repo", "cli", { at: 1, bytes: GB, outcome: "clean" });
    const web = readPeaks("/src/repo", "web");
    expect(web).toHaveLength(HISTORY);
    expect(web.at(-1)!.at).toBe(HISTORY + 399);
    expect(fs.readFileSync(peaksPath("/src/repo", "web"), "utf-8").split("\n").length).toBeLessThan(HISTORY + 400);
    expect(readPeaks("/src/other", "web")).toEqual([]);
  });

  test("ignores zero peaks and torn lines", () => {
    recordPeak("/r", "p", { at: 1, bytes: 0, outcome: "clean" });
    fs.mkdirSync(require("node:path").dirname(peaksPath("/r", "p")), { recursive: true });
    fs.appendFileSync(peaksPath("/r", "p"), '{"at":1,"bytes":5\n{"at":2,"bytes":1073741824,"outcome":"clean"}\n');
    expect(readPeaks("/r", "p")).toEqual([{ at: 2, bytes: GB, outcome: "clean" }]);
  });

  test("learned sizes list each project with its samples, p95 and reservation", () => {
    for (const gb of [2, 3, 4]) recordPeak("/src/codecast", "web", { at: 100, bytes: gb * GB, outcome: "clean" });
    recordPeak("/src/codecast", "cli", { at: 100, bytes: 1 * GB, outcome: "clean" });
    recordPeak("/src/codecast", "cli", { at: 101, bytes: 1 * GB, outcome: "oom" });
    const sizes = learnedSizes(10 * GB);
    expect(sizes.map((s) => [s.project, s.samples, s.warm, s.reservationBytes / GB, s.ooms])).toEqual([
      ["cli", 0, false, 10, 1],
      ["web", 3, true, 5, 0],
    ]);
  });
});

test("a watcher's memory is its own RSS plus every process under it", () => {
  const table: ProcTable = new Map([
    [10, { ppid: 1, rssBytes: 30 * 2 ** 20 }],
    [11, { ppid: 10, rssBytes: 2 * GB }],
    [12, { ppid: 11, rssBytes: 1 * GB }],
    [20, { ppid: 1, rssBytes: 5 * GB }],
  ]);
  expect(treeRssBytes(10, table)).toBe(30 * 2 ** 20 + 3 * GB);
  expect(treeRssBytes(99, table)).toBe(0);
  expect(treeRssBytes(process.pid)).toBeGreaterThan(10 * 2 ** 20);
  expect(rssOfPids([process.pid, 0])).toBeGreaterThan(10 * 2 ** 20);
  expect(rssOfPids([])).toBe(0);
  if (process.platform === "darwin") {
    // footprint counts compressed pages RSS leaves out; its peak never falls below what the process holds now.
    const f = footprintsOf([process.pid]).get(process.pid)!;
    expect(f.now).toBeGreaterThan(10 * 2 ** 20);
    expect(f.peak).toBeGreaterThanOrEqual(f.now);
    const peak = peakOfPids([process.pid]);
    expect(peak).toBeGreaterThanOrEqual(f.peak);
    expect(peak).toBeLessThanOrEqual(footprintsOf([process.pid]).get(process.pid)!.peak);
    // One call reads several pids; one it cannot find is left out, not a failure for the rest.
    const both = footprintsOf([process.pid, 999_999_999]);
    expect([...both.keys()]).toEqual([process.pid]);
    expect(footprintsOf([999_999_999]).size).toBe(0);
  }
});

describe("reading what the machine can give", () => {
  test("footprint's report of several pids is read per pid", () => {
    const text = `======================================================================
claude [11627]: 64-bit    Footprint: 282 MB (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 282 MB
    phys_footprint_peak: 323 MB

======================================================================
bash [22479]: 64-bit (translated)    Footprint: 4009 KB (4096 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 4041 KB
    phys_footprint_peak: 4669 KB

======================================================================
Summary Footprint: 286 MB
======================================================================`;
    expect(parseFootprints(text)).toEqual(new Map([[11627, { now: 282 * 2 ** 20, peak: 323 * 2 ** 20 }], [22479, { now: 4041 * 1024, peak: 4669 * 1024 }]]));
  });

  test("macOS: available is free, speculative, purgeable and file-backed inactive pages; swap and the kernel's verdict from sysctl", () => {
    const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     7821.
Pages inactive:                              1479206.
Pages speculative:                               678.
Pages purgeable:                                   8.
File-backed pages:                            966961.
Anonymous pages:                             1994891.`;
    // The 1.48M inactive pages are mostly anonymous: only the 0.97M file-backed ones count.
    expect(parseVmStat(vm)).toBe((7821 + 678 + 8 + 966961) * 16384);
    expect(parseVmStat("nothing")).toBeNull();
    expect(parseDarwinSysctl("vm.swapusage: total = 26624.00M  used = 25164.38M  free = 1459.62M  (encrypted)\nkern.memorystatus_vm_pressure_level: 2\n"))
      .toEqual({ swapTotalBytes: 26624 * 2 ** 20, swapUsedBytes: 25164.38 * 2 ** 20, pressureLevel: 2 });
    expect(parseDarwinSysctl("")).toBeNull();
  });

  test("Linux: MemAvailable and swap from /proc/meminfo", () => {
    expect(parseMeminfo("MemTotal:       65536000 kB\nMemAvailable:   20000000 kB\nSwapTotal:       8000000 kB\nSwapFree:        2000000 kB\n"))
      .toEqual({ availableBytes: 20000000 * 1024, swapTotalBytes: 8000000 * 1024, swapUsedBytes: 6000000 * 1024 });
  });
});

describe("the measured budget", () => {
  const cap = 102.4 * GB;
  const total = 128 * GB;
  const margin = Math.round(6.4 * GB);
  test("calm: what watchers hold plus available beyond the margin (a twentieth, 6.4 GB here), never above the cap", () => {
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 20 * GB, memory: { availableBytes: 30 * GB, swapUsedBytes: 0, swapTotalBytes: 0, pressureLevel: 1 } }))
      .toEqual({ budgetBytes: 20 * GB + 30 * GB - margin, pressure: false });
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 90 * GB, memory: { availableBytes: 30 * GB, swapUsedBytes: 0, swapTotalBytes: 0 } }).budgetBytes).toBe(cap);
  });

  test("the laptop at 21.0 of 21.5 GB swap with macOS at warn: no headroom at all", () => {
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 62 * GB, memory: { availableBytes: 16 * GB, swapUsedBytes: 21 * GB, swapTotalBytes: 21.5 * GB, pressureLevel: 2 } }))
      .toEqual({ budgetBytes: 62 * GB, pressure: true });
  });

  test("short of available memory with swap filling: less than the watchers hold, by the shortfall", () => {
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 30 * GB, memory: { availableBytes: 4 * GB, swapUsedBytes: 6 * GB, swapTotalBytes: 8 * GB } }))
      .toEqual({ budgetBytes: 30 * GB - (2 * margin - 4 * GB), pressure: true });
  });

  test("old swap on a machine with room is not pressure; an unreadable machine falls back to the cap", () => {
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 0, memory: { availableBytes: 40 * GB, swapUsedBytes: 3 * GB, swapTotalBytes: 4 * GB } }).pressure).toBe(false);
    expect(admissionBudget({ totalBytes: total, capBytes: cap, watcherBytes: 0, memory: null })).toEqual({ budgetBytes: cap, pressure: false });
  });
});

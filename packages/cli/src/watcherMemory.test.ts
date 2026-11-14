import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import {
  coldReservationBytes, countFloorWatchers, DEFAULT_COLD_BYTES, budgetBytes, FLOOR_BYTES, footprintOf, peakOfPids, rssOfPids, fitsBudget, holdBytes, HISTORY, learnedSizes, peaksPath, percentile, readPeaks, recordPeak,
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
  test("never runs fewer watchers than the count rule it replaced: one per 12 GB, 2 to 16", () => {
    expect(countFloorWatchers(128 * GB)).toBe(10);
    expect(countFloorWatchers(64 * GB)).toBe(5);
    expect(countFloorWatchers(16 * GB)).toBe(2);
    expect(countFloorWatchers(512 * GB)).toBe(16);
  });

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
    const f = footprintOf(process.pid)!;
    expect(f.now).toBeGreaterThan(10 * 2 ** 20);
    expect(f.peak).toBeGreaterThanOrEqual(f.now);
    const peak = peakOfPids([process.pid]);
    expect(peak).toBeGreaterThanOrEqual(f.peak);
    expect(peak).toBeLessThanOrEqual(footprintOf(process.pid)!.peak);
    expect(footprintOf(999_999_999)).toBeNull();
  }
});

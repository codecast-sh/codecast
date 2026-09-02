// Canned lines copied from the live daemon.log and pmset -g log.
import { describe, expect, test } from "bun:test";
import {
  parseDaemonLogLine,
  parseLoopFreeze,
  parsePmsetSleepWindows,
  classifyFreeze,
  buildLogReport,
  primaryStack,
  lastLogTag,
  type LoopFreezeEvent,
} from "./logReport.js";

const FREEZE_25S =
  "[2026-09-01T23:20:05.639Z] [LOOP-FREEZE] event loop blocked 25s (416ms CPU during the freeze); last log before it: 2026-09-01T23:19:38.265Z Synced 93 grok messages for session 01a05df0-060b-7f73-ac6f-6378b24a8fda; hot stacks: (anonymous)@recursiveWatcher.ts:118 96%, walk@recursiveWatcher.ts:138 71%, statSync 64%, walk@recursiveWatcher.ts:143 64%, readdirSync 32%";
// The last log of this one is itself a truncated LOOP-FREEZE line.
const FREEZE_8S_NESTED =
  "[2026-09-01T23:20:14.416Z] [LOOP-FREEZE] event loop blocked 8s (612ms CPU during the freeze); last log before it: 2026-09-01T23:20:05.639Z [LOOP-FREEZE] event loop blocked 25s (416ms CPU during the freeze); last log before it: 2026-09-01T23:19:38.265Z Synced 93 grok messages for session 01a05df0-06; hot stacks: processSessionFile@daemon.ts:6349 45%, (anonymous)@daemon.ts:19994 45%";
const FREEZE_SLEEP_1048S =
  "[2026-08-31T06:58:38.260Z] [LOOP-FREEZE] event loop blocked 1048s (44ms CPU during the freeze); last log before it: 2026-08-31T06:41:08.054Z Pending poll fallback failed: The socket connection was closed unexpectedly.; hot stacks: (anonymous)@cursorWatcher.ts:128 79%, readdirSync 76%";
const FREEZE_SWEEP =
  "[2026-08-28T19:57:02.928Z] [LOOP-FREEZE] event loop blocked 25s (14637ms CPU during the freeze); last log before it: 2026-08-28T19:56:23.740Z [SLOW-SYNC-SPAWN] spawnSync blocked the event loop 2181ms: lsappinfo front; hot stacks: (anonymous) 100%, processTicksAndRejections 100%, sweepGitPlaneFleet@daemon.ts:13717 100%";

const PMSET = [
  "2026-08-27 08:50:32 -0400 Sleep               \tEntering Sleep state due to 'Maintenance Sleep':TCPKeepAlive=active Using AC (Charge:100%) 202 secs  ",
  "2026-08-27 08:50:34 -0400 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=1019 wakeAt=2026-08-27 09:07:33 info=\"x\"]",
  "2026-08-27 08:53:54 -0400 DarkWake            \tDarkWake from Deep Idle [CDNPB] : due to smc.sysState.Wake(0x70070000) Using AC (Charge:100%) 8 secs    ",
  "2026-08-27 08:54:05 -0400 Sleep               \tEntering DarkWake state due to 'Notification Wake Back to Sleep':TCPKeepAlive=active Using AC (Charge:100%) 226 secs  ",
  "2026-08-27 08:57:51 -0400 Wake                \tDarkWake to FullWake from Deep Idle [CDNVAPB] : due to Notification Using AC (Charge:100%) 30 secs   ",
  "2026-08-27 08:58:21 -0400 Sleep               \tEntering DarkWake state due to 'Notification Wake Back to Sleep':TCPKeepAlive=active Using AC (Charge:100%) 30 secs   ",
].join("\n");

describe("parseDaemonLogLine", () => {
  test("handles the optional [WARN] tag", () => {
    const warn = parseDaemonLogLine("[2026-08-28T10:49:51.061Z] [WARN] Health: 10 pending files, 666 dropped ops, 0 in retry queue");
    expect(warn?.level).toBe("WARN");
    expect(warn?.message).toBe("Health: 10 pending files, 666 dropped ops, 0 in retry queue");
    expect(warn?.ts).toBe(Date.parse("2026-08-28T10:49:51.061Z"));
    const info = parseDaemonLogLine("[2026-08-28T13:16:46.256Z] Hook server listening on 127.0.0.1:50397");
    expect(info?.level).toBeNull();
    expect(info?.message).toBe("Hook server listening on 127.0.0.1:50397");
    expect(parseDaemonLogLine("garbage")).toBeNull();
  });
});

describe("parseLoopFreeze", () => {
  test("reads lateness, cpu, hot stacks and the last log", () => {
    const p = parseDaemonLogLine(FREEZE_25S)!;
    const ev = parseLoopFreeze(p.ts, p.message)!;
    expect(ev.lateMs).toBe(25000);
    expect(ev.cpuMs).toBe(416);
    expect(ev.hotStacks[0]).toBe("(anonymous)@recursiveWatcher.ts:118 96%");
    expect(primaryStack(ev.hotStacks)).toBe("(anonymous)@recursiveWatcher.ts:118");
    expect(lastLogTag(ev.lastLog)).toBe("Synced");
  });

  test("a nested LOOP-FREEZE last log keeps the outer hot stacks", () => {
    const p = parseDaemonLogLine(FREEZE_8S_NESTED)!;
    const ev = parseLoopFreeze(p.ts, p.message)!;
    expect(ev.lateMs).toBe(8000);
    expect(primaryStack(ev.hotStacks)).toBe("processSessionFile@daemon.ts:6349");
    expect(lastLogTag(ev.lastLog)).toBe("[LOOP-FREEZE]");
  });

  test("the primary stack skips bare anonymous frames", () => {
    const p = parseDaemonLogLine(FREEZE_SWEEP)!;
    const ev = parseLoopFreeze(p.ts, p.message)!;
    expect(primaryStack(ev.hotStacks)).toBe("sweepGitPlaneFleet@daemon.ts:13717");
    expect(lastLogTag(ev.lastLog)).toBe("[SLOW-SYNC-SPAWN]");
  });
});

describe("parsePmsetSleepWindows", () => {
  test("closes on the next Wake or DarkWake and falls back to the trailing secs", () => {
    const w = parsePmsetSleepWindows(PMSET);
    expect(w).toHaveLength(3);
    expect(w[0].start).toBe(Date.parse("2026-08-27T08:50:32-04:00"));
    expect(w[0].end).toBe(Date.parse("2026-08-27T08:53:54-04:00"));
    expect(w[1].end).toBe(Date.parse("2026-08-27T08:57:51-04:00"));
    // The last Sleep has no wake after it: 30 secs fallback.
    expect(w[2].end - w[2].start).toBe(30_000);
  });
});

describe("classifyFreeze", () => {
  const ev = (iso: string, lateS: number, cpuMs: number): LoopFreezeEvent => ({
    ts: Date.parse(iso), lateMs: lateS * 1000, cpuMs, lastLog: "", hotStacks: [],
  });

  test("a freeze overlapping a pmset window is sleep", () => {
    const windows = parsePmsetSleepWindows(PMSET);
    // Reported at 08:53:55 after 200s: covers 08:50:35 to 08:53:55, inside the first window.
    expect(classifyFreeze(ev("2026-08-27T12:53:55Z", 200, 30), windows)).toBe("sleep");
  });

  test("the 25s recursiveWatcher freeze beside a 'Sleep detected' line stays a freeze", () => {
    // pmset covers the day but has no window near 23:20 UTC.
    const windows = [{ start: Date.parse("2026-09-01T20:00:00Z"), end: Date.parse("2026-09-01T20:05:00Z") }];
    expect(classifyFreeze(ev("2026-09-01T23:20:05.639Z", 25, 416), windows)).toBe("freeze");
  });

  test("without pmset windows a long gap with near zero cpu is sleep, with real cpu a freeze", () => {
    expect(classifyFreeze(ev("2026-08-31T06:58:38Z", 1200, 2000), [])).toBe("sleep");
    expect(classifyFreeze(ev("2026-08-31T06:58:38Z", 1200, 300000), [])).toBe("freeze");
    expect(classifyFreeze(ev("2026-08-31T06:58:38Z", 25, 10), [])).toBe("freeze");
  });
});

describe("buildLogReport", () => {
  const lines = [
    "[2026-08-28T13:16:37.952Z] [LIFECYCLE] daemon_start: v1.1.113 PID=22124",
    "[2026-08-28T13:16:46.256Z] Hook server listening on 127.0.0.1:50397",
    "[2026-08-28T13:20:23.023Z] [SLOW-SYNC-SPAWN] spawnSync blocked the event loop 1034ms: lsappinfo front",
    "[2026-08-28T16:48:02.205Z] [SLOW-SYNC-SPAWN] spawnSync blocked the event loop 1037ms: lsappinfo front",
    "[2026-08-28T16:52:56.187Z] [SLOW-SYNC-SPAWN] execSync blocked the event loop 2527ms: git remote get-url origin",
    "[2026-08-28T11:54:59.008Z] [PS-SNAPSHOT] ps aux took 2521ms (926 lines)",
    "[2026-08-28T12:50:43.477Z] [PS-SNAPSHOT] ps aux took 8606ms (1007 lines)",
    FREEZE_SWEEP,
    FREEZE_SLEEP_1048S,
    FREEZE_25S,
    FREEZE_8S_NESTED,
    "[2026-09-01T23:30:00.000Z] [LIFECYCLE] daemon_start: v1.1.114 PID=99999",
    "[2026-08-01T00:00:00.000Z] [LOOP-FREEZE] event loop blocked 99s (1ms CPU during the freeze); last log before it: old",
  ];

  test("totals per hour, sleep excluded, histograms, spawn groups and boot pairing", () => {
    const report = buildLogReport(lines, { sinceMs: Date.parse("2026-08-28T00:00:00Z"), sleepWindows: [] });
    expect(report.linesRead).toBe(12);
    expect(report.freezes.rawCount).toBe(4);
    expect(report.freezes.sleepCount).toBe(1);
    expect(report.freezes.freezeCount).toBe(3);
    expect(report.freezes.totalMs).toBe(58_000);
    expect(report.freezes.maxMs).toBe(25_000);
    expect(report.freezes.perHour).toEqual([
      { hour: "2026-08-28T19", count: 1, totalMs: 25_000, maxMs: 25_000 },
      { hour: "2026-09-01T23", count: 2, totalMs: 33_000, maxMs: 25_000 },
    ]);
    expect(report.freezes.topStacks.map((s) => s.key)).toEqual([
      "(anonymous)@recursiveWatcher.ts:118",
      "processSessionFile@daemon.ts:6349",
      "sweepGitPlaneFleet@daemon.ts:13717",
    ]);
    expect(report.freezes.topLastLog).toEqual([
      { key: "Synced", count: 1 },
      { key: "[LOOP-FREEZE]", count: 1 },
      { key: "[SLOW-SYNC-SPAWN]", count: 1 },
    ]);

    expect(report.psSnapshot.n).toBe(2);
    expect(report.psSnapshot.maxMs).toBe(8606);
    expect(report.psSnapshot.buckets.map((b) => b.count)).toEqual([0, 1, 1, 0, 0]);

    expect(report.slowSpawn.n).toBe(3);
    expect(report.slowSpawn.groups[0]).toEqual({ command: "lsappinfo", count: 2, meanMs: 1036, maxMs: 1037 });
    expect(report.slowSpawn.groups[1].command).toBe("git");

    expect(report.boots).toEqual([
      { startedAt: "2026-08-28T13:16:37.952Z", version: "1.1.113", pid: 22124, listeningAt: "2026-08-28T13:16:46.256Z", blackoutMs: 8304 },
      { startedAt: "2026-09-01T23:30:00.000Z", version: "1.1.114", pid: 99999, listeningAt: null, blackoutMs: null },
    ]);
  });
});

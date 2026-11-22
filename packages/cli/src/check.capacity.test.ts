/**
 * The shared typecheck's capacity: how many watchers a machine runs at once,
 * who is admitted by memory, and who makes room. Split out of check.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";
import { machineMemoryProbe, parseVmStat, type MachineMemory, type Peak } from "./watcherMemory.js";
import { CheckFailure, summarize } from "./checkOutcome.js";
import { EXIT_BUSY } from "./infraExit.js";
import { BIG_BUILD_BYTES, capacityFor, checkProject, coldBuildCap, coldBuildsFit, COLD_BUILDS_ENV, eventsPath, lastLogLine, listQueue, listWatchers, machineCapacity, makeRoom, readWatchState, statePath, WANTED_MS, watchDir, watcherIdentity, watchReducer, writeWatchState, type WatchState } from "./check.js";

let isolation: IsolatedCodecastDir;
const realIdentity = watcherIdentity.matches;
const realMemory = machineMemoryProbe.read;
const realColdBuilds = process.env[COLD_BUILDS_ENV];
beforeEach(() => {
  // The cold-build cap follows this machine's cores; these tests pin it, and the cases about it set their own.
  process.env[COLD_BUILDS_ENV] = "16";
  isolation = isolateCodecastDir("cast-check-test-");
  // These tests stand in for a watcher with their own pid.
  watcherIdentity.matches = (command, pid) => pid === process.pid || realIdentity(command, pid);
  // This machine's free memory changes under the tests: they admit by the cap unless a case gives the machine's numbers.
  machineMemoryProbe.read = () => null;
});
afterEach(() => {
  isolation.restore();
  watcherIdentity.matches = realIdentity;
  machineMemoryProbe.read = realMemory;
  if (realColdBuilds === undefined) delete process.env[COLD_BUILDS_ENV];
  else process.env[COLD_BUILDS_ENV] = realColdBuilds;
});

describe("the machine wide watcher cap", () => {
  test("preserves running passes even when they were requested longest ago", () => {
    const state: WatchState = { pid: process.pid, project: "busy", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt: 1 };
    writeWatchState(watchDir("/tree", "busy"), state);
    writeWatchState(watchDir("/tree", "idle"), { ...state, project: "idle", inProgress: false, askedAt: 2 });
    expect(makeRoom(2, () => {})?.map((w) => w.project)).toEqual(["idle"]);
    expect(readWatchState(watchDir("/tree", "busy"))).not.toBeNull();
  });

  test("a run's own programs are stopped last, so `cast check` never rebuilds what it just checked", () => {
    const state: WatchState = { pid: process.pid, project: "mine", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, askedAt: 1 };
    writeWatchState(watchDir("/tree", "mine"), state);
    writeWatchState(watchDir("/other", "theirs"), { ...state, project: "theirs", root: "/other", askedAt: 2 });
    const protect = new Set([watchDir("/tree", "mine")]);
    expect(makeRoom(2, () => {}, Date.now(), protect)?.map((w) => w.project)).toEqual(["theirs"]);
    // Only protected programs left: the oldest still gives way rather than deadlocking the run.
    expect(makeRoom(1, () => {}, Date.now(), protect)?.map((w) => w.project)).toEqual(["mine"]);
    expect(fs.readFileSync(eventsPath(), "utf-8")).toMatch(/ evict theirs \/other .*cap 2\n.* evict mine \/tree /);
  });

  test("an ask waits in the queue while every slot holds a wanted pass, and gives up at its budget without killing any", async () => {
    const state: WatchState = { pid: process.pid, project: "busy", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt: Date.now() };
    writeWatchState(watchDir("/tree", "busy"), state);
    const killed: number[] = [];
    const notes: string[] = [];
    let starts = 0;
    await expect(checkProject({ name: "next", tsconfig: "x" }, "/tree", {
      maxWatchers: 1, budgetMs: 1, kill: (pid) => killed.push(pid), start: () => { starts++; }, note: (l) => notes.push(l),
    })).rejects.toThrow("still queued");
    expect(notes.some((l) => l.startsWith("queued for the 1 typecheck slot:"))).toBe(true);
    expect(killed).toEqual([]);
    expect(starts).toBe(0);
    expect(readWatchState(watchDir("/tree", "busy"))).not.toBeNull();
    expect(listQueue()).toEqual([]);
  });

  test("a queued ask starts its watcher as soon as the slot's pass finishes", async () => {
    const busyDir = watchDir("/tree", "busy");
    const busy: WatchState = { pid: process.pid, project: "busy", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt: Date.now() };
    writeWatchState(busyDir, busy);
    const killed: number[] = [];
    const start = (root: string, project: { name: string; tsconfig: string }) =>
      writeWatchState(watchDir(root, project.name), { pid: process.pid, project: project.name, tsconfig: project.tsconfig, root, startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 0 });
    const ask = checkProject({ name: "next", tsconfig: "x" }, "/tree", { maxWatchers: 1, kill: (pid) => killed.push(pid), start });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(killed).toEqual([]);
    writeWatchState(busyDir, { ...busy, inProgress: false, finishedAt: Date.now(), errors: 0 });
    const r = await ask;
    expect(r).toMatchObject({ project: "next", errors: 0, started: true });
    expect(killed).toEqual([process.pid]);
    expect(readWatchState(busyDir)).toBeNull();
  });

  test("a program that gave up and asked again keeps its place ahead of later asks", async () => {
    writeWatchState(watchDir("/tree", "busy"), { pid: process.pid, project: "busy", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt: Date.now() });
    const opts = { maxWatchers: 1, budgetMs: 1, start: () => {} };
    await expect(checkProject({ name: "first", tsconfig: "x" }, "/tree", opts)).rejects.toThrow("still queued");
    const later = checkProject({ name: "later", tsconfig: "x" }, "/tree", { ...opts, budgetMs: 3_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const again = checkProject({ name: "first", tsconfig: "x" }, "/tree", { ...opts, budgetMs: 3_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    expect(listQueue().map((t) => t.project)).toEqual(["first", "later"]);
    await Promise.all([later, again]);
  });

  test("a running pass nobody waits on gives up its slot; one somebody waits on does not", () => {
    const now = Date.now();
    const seed = (project: string, askedAt: number) =>
      writeWatchState(watchDir("/tree", project), { pid: process.pid, project, tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true, askedAt });
    seed("wanted", now);
    expect(makeRoom(1, () => {}, now)).toBeNull();
    seed("abandoned", now - WANTED_MS - 1);
    expect(makeRoom(2, () => {}, now)?.map((w) => w.project)).toEqual(["abandoned"]);
    expect(readWatchState(watchDir("/tree", "wanted"))).not.toBeNull();
  });

  test("concurrent starts for different projects cannot exceed the cap", async () => {
    const starts: string[] = [];
    const start = (root: string, project: { name: string; tsconfig: string }) => {
      starts.push(project.name);
      setTimeout(() => writeWatchState(watchDir(root, project.name), {
        pid: process.pid, project: project.name, tsconfig: project.tsconfig, root,
        startedAt: Date.now(), inProgress: true,
      }), 100);
    };
    const results = await Promise.allSettled(["a", "b"].map((name) => checkProject({ name, tsconfig: "x" }, "/tree", { start, maxWatchers: 1, budgetMs: 1 })));
    expect(starts).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && r.reason.message.includes("still queued"))).toHaveLength(1);
  });

  test("the least recently asked watchers are stopped to make room, and their state files go with them", () => {
    const now = Date.now();
    const seed = (root: string, project: string, askedAt: number) =>
      writeWatchState(watchDir(root, project), { pid: process.pid, project, tsconfig: "x", root, startedAt: 1, inProgress: false, finishedAt: now, errors: 0, askedAt });
    seed("/t1", "a", now - 3_000);
    seed("/t1", "b", now - 1_000);
    seed("/t2", "a", now - 2_000);
    const killed: number[] = [];
    const evicted = makeRoom(2, (pid) => killed.push(pid));
    expect(evicted?.map((w) => `${w.root}/${w.project}`)).toEqual(["/t1/a", "/t2/a"]);
    expect(killed).toHaveLength(2);
    expect(readWatchState(watchDir("/t1", "a"))).toBeNull();
    expect(readWatchState(watchDir("/t1", "b"))).not.toBeNull();
    // A state file whose pid is dead is cleared on listing rather than counted.
    writeWatchState(watchDir("/t3", "z"), { pid: 999999999, project: "z", tsconfig: "x", root: "/t3", startedAt: 1, inProgress: true });
    expect(makeRoom(2, () => {})).toEqual([]);
    expect(readWatchState(watchDir("/t3", "z"))).toBeNull();
  });
});

describe("admission by memory", () => {
  const GB = 2 ** 30;
  const seed = (project: string, extra: Partial<WatchState> = {}) =>
    writeWatchState(watchDir("/tree", project), { pid: process.pid, project, tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: 1, firstFinishedAt: 1, errors: 0, askedAt: 1, ...extra });
  const sizes: Record<string, number> = { web: 6 * GB, cli: 2 * GB, convex: 3 * GB };
  const capacity = (needBytes: number, budget = 12 * GB) => ({ maxWatchers: 16, budgetBytes: budget, needBytes, holdOf: (w: WatchState) => sizes[w.project] ?? 0 });

  test("small watchers no longer count as whole slots: a new one starts beside them while memory fits", () => {
    seed("web");
    seed("cli");
    expect(makeRoom(capacity(3 * GB), () => {})).toEqual([]);
  });

  test("past the budget, the least recently asked are stopped until the need fits, and the event names the memory", () => {
    seed("web", { askedAt: 3 });
    seed("cli", { askedAt: 1 });
    seed("convex", { askedAt: 2 });
    const evicted = makeRoom(capacity(4 * GB), () => {});
    expect(evicted?.map((w) => w.project)).toEqual(["cli", "convex"]);
    expect(fs.readFileSync(eventsPath(), "utf-8")).toMatch(/evict cli \/tree .*11\.0 GB reserved of 12\.0 GB, need 4\.0 GB, frees 2\.0 GB/);
    // The victim's log ends saying so, so an asker still waiting on it retries instead of reporting a death.
    expect(lastLogLine(watchDir("/tree", "cli"))).toMatch(/^stopped to make room for another watcher \(cap 16, 11\.0 GB reserved/);
  });

  test("an ask behind the first gets no empty-machine pass: it must fit beside the first's need", () => {
    expect(makeRoom({ ...capacity(13 * GB), strict: true }, () => {}, Date.now(), new Set(), false)).toBeNull();
    expect(makeRoom({ ...capacity(12 * GB), strict: true }, () => {}, Date.now(), new Set(), false)).toEqual([]);
    expect(makeRoom(capacity(13 * GB), () => {}, Date.now(), new Set(), false)).toEqual([]);
  });

  test("an ask further back in line starts if it fits as things are, and never stops anything to fit", () => {
    seed("web", { askedAt: 3 });
    const killed: number[] = [];
    expect(makeRoom(capacity(5 * GB), (pid) => killed.push(pid), Date.now(), new Set(), false)).toEqual([]);
    expect(makeRoom(capacity(7 * GB), (pid) => killed.push(pid), Date.now(), new Set(), false)).toBeNull();
    expect(killed).toEqual([]);
  });

  test("a need that only fits by stopping a wanted pass waits, and stops nothing", () => {
    seed("web", { inProgress: true, askedAt: Date.now() });
    const killed: number[] = [];
    expect(makeRoom(capacity(7 * GB), (pid) => killed.push(pid))).toBeNull();
    expect(killed).toEqual([]);
  });

  test("a watcher written before memory admission (no repo, no peak) is read and held by what it measures", () => {
    const dir = watchDir("/tree", "legacy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath(dir), JSON.stringify({ pid: process.pid, project: "legacy", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: false, finishedAt: 1, firstFinishedAt: 1, errors: 0 }));
    const cap = machineCapacity("/tree", "next", 16);
    const [w] = listWatchers();
    expect(w!.repo).toBeUndefined();
    const held = cap.holdOf!(w!);
    expect(held).toBeGreaterThan(10 * 2 ** 20);
    expect(held).toBeLessThan(cap.ceilingBytes);
  });

  describe("through the machine's own measurements", () => {
    // A budget of 0.3 GB: this test process (the "watcher") measures more than that with any need beside it.
    let before: string | undefined;
    beforeEach(() => {
      before = process.env.CAST_CHECK_RESERVE_GB;
      process.env.CAST_CHECK_RESERVE_GB = String(os.totalmem() / GB - 0.3);
    });
    afterEach(() => {
      if (before === undefined) delete process.env.CAST_CHECK_RESERVE_GB;
      else process.env.CAST_CHECK_RESERVE_GB = before;
    });

    test("an ask queues for memory behind a wanted pass, and gives up as busy", async () => {
      seed("busy0", { inProgress: true, askedAt: Date.now(), peakRssBytes: GB });
      const notes: string[] = [];
      const err = await checkProject({ name: "next", tsconfig: "x" }, "/tree", { budgetMs: 1, start: () => { throw new Error("must not start"); }, note: (l) => notes.push(l) }).catch((e) => e);
      expect(err).toBeInstanceOf(CheckFailure);
      expect(err.kind).toBe("busy");
      expect(notes.some((l) => /^queued for typecheck memory \(needs 0\.\d GB of 0\.3 GB\): the live watchers hold passes someone is waiting on \(busy/.test(l))).toBe(true);
    });

    test("a queued ask answers 75 within the queue's own wait, however long the caller would have waited", async () => {
      seed("busy0", { inProgress: true, askedAt: Date.now(), peakRssBytes: GB });
      const t = Date.now();
      const err = await checkProject({ name: "next", tsconfig: "x" }, "/tree", { budgetMs: 60_000, queueWaitMs: 1_500, start: () => { throw new Error("must not start"); } }).catch((e) => e);
      expect(err.kind).toBe("busy");
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(summarize([{ project: "next", failure: err }]).exit).toBe(EXIT_BUSY);
    });

    test("an idle watcher is stopped to make room, by the peak it reached", async () => {
      seed("idle0", { peakRssBytes: GB, askedAt: 1 });
      const killed: number[] = [];
      const notes: string[] = [];
      const start = (root: string, project: { name: string; tsconfig: string }) =>
        writeWatchState(watchDir(root, project.name), { pid: process.pid, project: project.name, tsconfig: project.tsconfig, root, startedAt: Date.now(), inProgress: false, finishedAt: Date.now(), errors: 0 });
      const r = await checkProject({ name: "next", tsconfig: "x" }, "/tree", { kill: (pid) => killed.push(pid), start, note: (l) => notes.push(l) });
      expect(r).toMatchObject({ project: "next", started: true, firstPass: true });
      expect(killed).toEqual([process.pid]);
      expect(notes).toContain("stopped the idle0 watcher for /tree (idle longest) to stay within the 0.3 GB typecheck watchers share on this machine");
    });
  });

  test("each finished pass hands its hooks the moment to record a peak, before the state is written", () => {
    const dir = watchDir("/tree", "cli");
    const state: WatchState = { pid: process.pid, project: "cli", tsconfig: "x", root: "/tree", startedAt: 1, inProgress: true };
    const events: string[] = [];
    const reduce = watchReducer(dir, state, { onStart: () => events.push("start"), onDone: () => { events.push("done"); state.peakRssBytes = 123; } });
    reduce("[9:41:02 AM] Starting compilation in watch mode...");
    reduce("Found 0 errors. Watching for file changes.");
    expect(events).toEqual(["start", "done"]);
    expect(readWatchState(dir)?.peakRssBytes).toBe(123);
  });
});

describe("the 128 GB machine the first version throttled (MacBook-Pro-182, 2026-11-14)", () => {
  const GB = 2 ** 30;
  // Learned there: web 5.4 GB, mobile 3.8, backend 6.4 (p95); cli unmeasured.
  const learned: Record<string, number> = { web: 5.4, mobile: 3.8, backend: 6.4 };
  const peaksFor = (project: string) => (learned[project] ? [1, 2, 3].map((at) => ({ at, bytes: learned[project]! * GB, outcome: "clean" as const })) : []);
  const projects = ["web", "mobile", "backend", "cli"];

  /** Start watchers one by one, every one a first pass someone is waiting on (none can be stopped), until admission says no. */
  function concurrent(opts: { env?: NodeJS.ProcessEnv; learnedP95s?: number[]; peaks?: (p: string) => ReturnType<typeof peaksFor>; use?: (p: string) => number }): number {
    const peaks = opts.peaks ?? peaksFor;
    const use = new Map<string, number>();
    let started = 0;
    for (let i = 0; i < 40; i++) {
      const project = projects[i % projects.length]!;
      const cap = capacityFor({
        totalBytes: 128 * GB, maxWatchers: 16, env: opts.env ?? {},
        needPeaks: () => peaks(project), peaksOf: (w) => peaks(w.project),
        learnedP95s: opts.learnedP95s ?? Object.values(learned).map((g) => g * GB),
        measure: (w) => use.get(w.dir) ?? 0,
      });
      if (makeRoom(cap, () => { throw new Error("nothing here may be stopped"); }) === null) break;
      const root = `/wt${i}`;
      writeWatchState(watchDir(root, project), { pid: process.pid, project, tsconfig: "x", root, startedAt: Date.now(), inProgress: true, askedAt: Date.now() });
      use.set(watchDir(root, project), (opts.use ?? ((p) => (learned[p] ?? 2) * GB * 0.6))(project));
      started++;
    }
    return started;
  }

  test("with the learned sizes, all 16 slots fill: more than the 10 the count rule allowed", () => {
    expect(concurrent({})).toBe(16);
  });

  test("with nothing learned yet (the rollout moment that broke), still at least 10", () => {
    expect(concurrent({ learnedP95s: [], peaks: () => [] })).toBeGreaterThanOrEqual(10);
  });

  test("when memory says the machine is full, one watcher still runs, and no more", () => {
    expect(concurrent({ env: { CAST_CHECK_RESERVE_GB: "127" }, use: () => 8 * GB })).toBe(1);
  });

  test("the numbers check-status showed then are now a machine with room", () => {
    const cap = capacityFor({ totalBytes: 128 * GB, maxWatchers: 16, env: {}, needPeaks: () => [], peaksOf: (w) => peaksFor(w.project), learnedP95s: Object.values(learned).map((g) => g * GB), measure: () => 0 });
    expect(cap.budgetBytes).toBe(Math.round(128 * GB * 0.8));
    expect(cap.capBytes).toBe(Math.round(128 * GB * 0.8));
    expect(cap.pressure).toBe(false);
    expect(cap.coldBytes).toBe(5.4 * GB);
    expect(cap.needBytes).toBe(5.4 * GB);
  });
});

describe("admission by what the machine can give now", () => {
  const GB = 2 ** 30;
  // `vm_stat` on the 128 GB laptop the fixed budget put 21 GB into swap (2026-11-21, load ~260).
  const laptopVmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     7821.
Pages active:                                1481968.
Pages inactive:                              1479206.
Pages speculative:                               678.
Pages throttled:                                   0.
Pages wired down:                            1062436.
Pages purgeable:                                   8.
File-backed pages:                            966961.
Anonymous pages:                             1994891.`;
  const laptop: MachineMemory = { availableBytes: parseVmStat(laptopVmStat)!, swapUsedBytes: 21.0 * GB, swapTotalBytes: 21.5 * GB, pressureLevel: 2 };
  const warm = (gb: number): Peak[] => [1, 2, 3].map((at) => ({ at, bytes: gb * GB, outcome: "clean" as const }));
  const sizes = new Map<string, number>();
  const seed = (project: string, gb: number, extra: Partial<WatchState> = {}) => {
    const root = `/wt/${project}`;
    writeWatchState(watchDir(root, project), { pid: process.pid, project, tsconfig: "x", root, startedAt: 1, inProgress: false, finishedAt: 1, firstFinishedAt: 1, errors: 0, askedAt: 1, peakRssBytes: gb * GB, ...extra });
    sizes.set(watchDir(root, project), gb * GB);
  };
  const capacity = (memory: MachineMemory | null) => capacityFor({
    totalBytes: 128 * GB, maxWatchers: 16, env: {},
    needPeaks: () => warm(5.4), peaksOf: () => warm(5.4), learnedP95s: [5.4 * GB],
    measure: (w) => sizes.get(w.dir) ?? 0, watchers: listWatchers, memory: () => memory,
  });
  afterEach(() => sizes.clear());

  /** The laptop's 16 watchers: 10 idle, 4 stuck "checking" that nobody asked about for hours, 2 passes someone waits on. */
  const seedLaptop = () => {
    for (let i = 0; i < 10; i++) seed(`idle${i}`, 3, { askedAt: 100 + i });
    for (let i = 0; i < 4; i++) seed(`stuck${i}`, 5, { inProgress: true, askedAt: Date.now() - 2 * 60 * 60_000 });
    for (let i = 0; i < 2; i++) seed(`wanted${i}`, 6, { inProgress: true, askedAt: Date.now() });
  };

  test("on the laptop in swap, a new watcher only replaces the least recently asked: the machine never takes on more", () => {
    seedLaptop();
    const cap = capacity(laptop);
    // 62 GB held, 16 GB available: under the fixed rule that was room for 40 GB more (a 102.4 GB budget).
    expect(cap.pressure).toBe(true);
    expect(cap.budgetBytes).toBe(62 * GB);
    const evicted = makeRoom(cap, () => {})!;
    expect(evicted.map((w) => w.project)).toEqual(["idle0", "idle1", "idle2"]);
    const live = listWatchers();
    expect(live.map((w) => w.project)).toEqual(expect.arrayContaining(["wanted0", "wanted1"]));
    // Freed 9 GB for a 6.75 GB need: the fleet shrinks by what it gave up, and the event says why.
    expect(live.reduce((a, w) => a + sizes.get(w.dir)!, 0) + cap.needBytes!).toBeLessThanOrEqual(62 * GB);
    expect(fs.readFileSync(eventsPath(), "utf-8")).toMatch(/evict idle0 .*62\.0 GB reserved of 62\.0 GB under memory pressure, need 6\.8 GB/);
  });

  test("short of memory, eviction also pays back what available memory falls short of the bar", () => {
    seedLaptop();
    // Linux has no kernel verdict: swap more than half used with 4 GB available is pressure, 8.8 GB short of twice the 6.4 GB margin.
    const cap = capacity({ availableBytes: 4 * GB, swapUsedBytes: 6 * GB, swapTotalBytes: 8 * GB });
    expect(cap.pressure).toBe(true);
    const evicted = makeRoom(cap, () => {})!;
    // 6.75 GB need + 8.8 GB deficit: six idle watchers (18 GB), not the three the need alone takes.
    expect(evicted.map((w) => w.project)).toEqual(["idle0", "idle1", "idle2", "idle3", "idle4", "idle5"]);
  });

  test("when only wanted passes are left to stop, the ask waits rather than push the machine further", () => {
    for (let i = 0; i < 2; i++) seed(`wanted${i}`, 6, { inProgress: true, askedAt: Date.now() });
    expect(makeRoom(capacity(laptop), () => { throw new Error("nothing here may be stopped"); })).toBeNull();
  });

  test("an empty machine under pressure still runs the first watcher an ask needs, but nothing behind it", () => {
    const cap = capacity(laptop);
    expect(makeRoom(cap, () => {})).toEqual([]);
    expect(makeRoom({ ...cap, strict: true }, () => {}, Date.now(), new Set(), false)).toBeNull();
  });

  test("a calm machine admits beside live watchers what is available beyond the margin, and no more", () => {
    seed("web", 5, { askedAt: 1 });
    seed("cli", 2, { askedAt: 2 });
    // 7 GB held + 20 GB available - 6.4 GB margin: a 6.75 GB need fits beside them.
    expect(makeRoom(capacity({ availableBytes: 20 * GB, swapUsedBytes: 0, swapTotalBytes: 0, pressureLevel: 1 }), () => {})).toEqual([]);
    // 10 GB available leaves 3.6 GB: the less recently asked one goes.
    expect(makeRoom(capacity({ availableBytes: 10 * GB, swapUsedBytes: 0, swapTotalBytes: 0, pressureLevel: 1 }), () => {})?.map((w) => w.project)).toEqual(["web"]);
  });

  test("nearly full swap with plenty available is old swap, not pressure", () => {
    seed("web", 5);
    const cap = capacity({ availableBytes: 40 * GB, swapUsedBytes: 3 * GB, swapTotalBytes: 4 * GB });
    expect(cap.pressure).toBe(false);
    expect(makeRoom(cap, () => {})).toEqual([]);
  });
});

describe("cold builds: first passes run a few at a time", () => {
  const GB = 2 ** 30;

  test("the cap scales with cores, 1 to 3, unless set", () => {
    expect(coldBuildCap(4, {})).toBe(1);
    expect(coldBuildCap(12, {})).toBe(2);
    expect(coldBuildCap(18, {})).toBe(3);
    expect(coldBuildCap(64, {})).toBe(3);
    expect(coldBuildCap(18, { [COLD_BUILDS_ENV]: "5" })).toBe(5);
    expect(coldBuildCap(18, { [COLD_BUILDS_ENV]: "0" })).toBe(3);
  });

  test("a big project counts as two, and one always runs on a machine building nothing", () => {
    const big = BIG_BUILD_BYTES + GB;
    expect(coldBuildsFit([], big, 1)).toBe(true);
    expect(coldBuildsFit([null, 2 * GB], null, 3)).toBe(true);
    expect(coldBuildsFit([null, 2 * GB, null], null, 3)).toBe(false);
    // Two small fit in three; two big do not.
    expect(coldBuildsFit([null], null, 3)).toBe(true);
    expect(coldBuildsFit([big], big, 3)).toBe(false);
    expect(coldBuildsFit([big], null, 3)).toBe(true);
    expect(coldBuildsFit([big], null, 2)).toBe(false);
  });

  test("the boot burst: 16 asks at once start at most the cap, the rest as first passes finish, in order", async () => {
    process.env[COLD_BUILDS_ENV] = "3";
    const started: string[] = [];
    const start = (root: string, project: { name: string; tsconfig: string }) => {
      started.push(project.name);
      writeWatchState(watchDir(root, project.name), { pid: process.pid, project: project.name, tsconfig: project.tsconfig, root, startedAt: Date.now(), inProgress: true, askedAt: Date.now() });
    };
    const notes: string[] = [];
    const names = Array.from({ length: 16 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const asks: Array<Promise<unknown>> = [];
    for (const name of names) {
      asks.push(checkProject({ name, tsconfig: "x" }, "/tree", { start, maxWatchers: 16, budgetMs: 400_000, queueWaitMs: 400_000, note: (l) => notes.push(`${name}: ${l}`) }));
      // Joining one after another fixes the order the queue keeps.
      await new Promise((r) => setTimeout(r, 5));
    }
    const cold = () => listWatchers().filter((w) => !w.firstFinishedAt);
    // Starts come seconds apart on a loaded machine: wait for the count expected, then a while longer to see no more.
    const startsReach = async (n: number) => {
      for (const until = Date.now() + 90_000; started.length < n && Date.now() < until; ) {
        await new Promise((r) => setTimeout(r, 250));
        expect(cold().length).toBeLessThanOrEqual(3);
      }
      await new Promise((r) => setTimeout(r, 2_000));
      expect(cold().length).toBeLessThanOrEqual(3);
      expect(started).toEqual(names.slice(0, n));
    };
    await startsReach(3);
    expect(notes).toContain("p03: queued: waiting for 3 cold builds to finish (3 first passes at a time on this machine); starting when one does (cast queue lists them)");
    // An ask for a watcher that already exists is never held by the cap: it waits on that watcher's pass, not the queue.
    const again = await checkProject({ name: "p00", tsconfig: "x" }, "/tree", { start, maxWatchers: 16, budgetMs: 1_000 }).catch((e) => e);
    expect(again).toBeInstanceOf(CheckFailure);
    expect(again.kind).toBe("wait-elapsed");
    expect(started).toHaveLength(3);
    // Finishing one first pass lets exactly one more start.
    const finish = (w: WatchState & { dir: string }) => writeWatchState(w.dir, { ...w, inProgress: false, finishedAt: Date.now(), firstFinishedAt: Date.now(), errors: 0 });
    finish(cold()[0]!);
    await startsReach(4);
    while (started.length < names.length) {
      const next = Math.min(names.length, started.length + cold().length);
      for (const w of cold()) finish(w);
      await startsReach(next);
    }
    for (const w of cold()) finish(w);
    await Promise.all(asks);
  }, 400_000);
});

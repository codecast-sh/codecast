import { describe, test, expect, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import { EventEmitter } from "node:events";
import * as os from "os";
import * as path from "path";
import { watch as chokidarWatch } from "chokidar";
import { RecursiveWatcher, chokidarIgnored } from "./recursiveWatcher.js";
import { watchDirFilter } from "./sessionWatcher.js";
import { transcriptDirWatcherConfig } from "./transcriptDirWatcher.js";
import { loopHoldBoundMs, measureLoopHold } from "./test-helpers/loopHold.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
  cleanups.length = 0;
});

describe("RecursiveWatcher", () => {
  test("detects new file creation", async () => {
    const root = tmpDir("rw-create");
    fs.mkdirSync(root, { recursive: true });

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();

    // Wait a bit for watcher to initialize
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "test.jsonl");
    fs.writeFileSync(filePath, '{"test": true}\n');

    // Wait for debounce + processing
    await new Promise(r => setTimeout(r, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.path === filePath)).toBe(true);
  });

  test("detects file modification", async () => {
    const root = tmpDir("rw-modify");
    fs.mkdirSync(root, { recursive: true });

    const filePath = path.join(root, "existing.jsonl");
    fs.writeFileSync(filePath, '{"line": 1}\n');

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    fs.appendFileSync(filePath, '{"line": 2}\n');
    await new Promise(r => setTimeout(r, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.path === filePath)).toBe(true);
  });

  test("filters by extension", async () => {
    const root = tmpDir("rw-filter");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
      // bun names only the first file of a same-tick burst (the .txt here);
      // the .jsonl is recovered by the throttled rescan.
      rescanIntervalMs: 200,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Write a .txt file -- should be filtered out
    fs.writeFileSync(path.join(root, "ignore.txt"), "ignored");
    // Write a .jsonl file -- should be detected
    const goodFile = path.join(root, "good.jsonl");
    fs.writeFileSync(goodFile, '{"ok": true}\n');

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("ignore.txt"))).toBe(false);
    expect(events.some(e => e.includes("good.jsonl"))).toBe(true);
  });

  test("respects maxDepth", async () => {
    const root = tmpDir("rw-depth");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      maxDepth: 2,
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // depth 1: subdir/file.jsonl -- should work
    const shallow = path.join(root, "subdir");
    fs.mkdirSync(shallow, { recursive: true });
    fs.writeFileSync(path.join(shallow, "ok.jsonl"), "{}");

    // depth 3: a/b/c/deep.jsonl -- should be filtered out by maxDepth
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "deep.jsonl"), "{}");

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("ok.jsonl"))).toBe(true);
    expect(events.some(e => e.includes("deep.jsonl"))).toBe(false);
  });

  test("debounces rapid writes", async () => {
    const root = tmpDir("rw-debounce");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 200,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "rapid.jsonl");
    // Write rapidly 5 times
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(filePath, `{"i": ${i}}\n`);
      await new Promise(r => setTimeout(r, 20));
    }

    // Wait for debounce to settle
    await new Promise(r => setTimeout(r, 500));

    // Should have coalesced into fewer events than 5
    const rapidEvents = events.filter(e => e.includes("rapid.jsonl"));
    expect(rapidEvents.length).toBeLessThan(5);
    expect(rapidEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("stop cleans up and no more events fire", async () => {
    const root = tmpDir("rw-stop");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();
    expect(watcher.isWatching).toBe(false);

    // Write after stop -- should NOT trigger callback
    fs.writeFileSync(path.join(root, "after-stop.jsonl"), "{}");
    await new Promise(r => setTimeout(r, 300));

    expect(events.some(e => e.includes("after-stop.jsonl"))).toBe(false);
  });

  test("restart works correctly", async () => {
    const root = tmpDir("rw-restart");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    await watcher.restart();
    expect(watcher.isWatching).toBe(true);
    await new Promise(r => setTimeout(r, 200));

    fs.writeFileSync(path.join(root, "after-restart.jsonl"), "{}");
    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("after-restart.jsonl"))).toBe(true);
  });

  test("handles deleted files gracefully", async () => {
    const root = tmpDir("rw-delete");
    fs.mkdirSync(root, { recursive: true });

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "ephemeral.jsonl");
    fs.writeFileSync(filePath, "{}");
    // Delete immediately before debounce fires
    await new Promise(r => setTimeout(r, 10));
    fs.unlinkSync(filePath);

    // Should not crash -- the debounce handler catches the stat error
    await new Promise(r => setTimeout(r, 300));
    // No assertion needed -- just verifying no crash
  });

  test("creates watch directory if missing", async () => {
    const root = tmpDir("rw-missing-dir");

    const watcher = new RecursiveWatcher({
      path: root,
      filter: () => true,
      callback: () => {},
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    expect(fs.existsSync(root)).toBe(false);
    watcher.start();
    expect(fs.existsSync(root)).toBe(true);
  });

  test("detects files in nested subdirectories", async () => {
    const root = tmpDir("rw-nested");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Create a new subdirectory and write a file into it
    const subDir = path.join(root, "new-project");
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, "session.jsonl");
    fs.writeFileSync(filePath, '{"msg": "hello"}\n');

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("session.jsonl"))).toBe(true);
  });
});

// dirFilter exists because the walk applied `filter` to files only, so it
// recursed through every directory under the root and merely discarded what it
// found. On a code repository that means walking node_modules on priming and
// again on every debounced rescan — a permanent tax that scales with dependency
// count, and one that breaks nothing visible when it regresses. Hence these.
describe("RecursiveWatcher dirFilter", () => {
  function scaffold(prefix: string): string {
    const root = tmpDir(prefix);
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "pkg", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "one.md"), "one");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "readme.md"), "dep");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "deep", "nested.md"), "deep");
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
  }

  /** Directories the priming walk actually opened. `filter` only ever sees
   *  files, so the directory a file sits in is one the walk had to read. */
  async function visitedDirs(root: string, dirFilter?: (rel: string) => boolean): Promise<string[]> {
    const visited: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => {
        visited.push(path.dirname(rel));
        return rel.endsWith(".md");
      },
      ...(dirFilter ? { dirFilter } : {}),
      callback: () => {},
    });
    cleanups.push(() => watcher.stop());
    watcher.start();
    await watcher.whenPrimed();
    watcher.stop();
    return visited;
  }

  test("without one, the walk descends into every directory", async () => {
    const visited = await visitedDirs(scaffold("rw-nofilter"));
    expect(visited).toContain(path.join("node_modules", "pkg"));
    expect(visited).toContain(path.join("node_modules", "pkg", "deep"));
  });

  test("a rejected directory is never opened, at any depth", async () => {
    const visited = await visitedDirs(scaffold("rw-dirfilter"), (rel) =>
      !rel.split(path.sep).includes("node_modules"),
    );
    expect(visited).toContain("notes");
    // Not merely "no events from node_modules" — the directory is never read,
    // which is the whole point of the option.
    expect(visited.some((d) => d.split(path.sep).includes("node_modules"))).toBe(false);
  });

  test("events from a rejected directory cost no rescan", async () => {
    const root = scaffold("rw-dirfilter-event");
    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".md"),
      dirFilter: (rel) => !rel.split(path.sep).includes("node_modules"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
      // bun names only the first file of a same-tick burst (the rejected one
      // here); the signal file is recovered by the throttled rescan.
      rescanIntervalMs: 200,
    });
    cleanups.push(() => watcher.stop());
    watcher.start();
    await new Promise((r) => setTimeout(r, 200));

    fs.writeFileSync(path.join(root, "node_modules", "pkg", "new.md"), "noise");
    fs.writeFileSync(path.join(root, "notes", "two.md"), "signal");
    await new Promise((r) => setTimeout(r, 600));

    expect(events.some((p) => p.endsWith(path.join("notes", "two.md")))).toBe(true);
    expect(events.some((p) => p.includes("node_modules"))).toBe(false);
  });
});

// The native watcher used to answer every event with a synchronous walk of the
// named file's whole subtree, 100ms later. Under ~/.claude/projects that was one
// project's ~1700 directories per transcript append, per live session — several
// full walks a second on the daemon's main thread, and a 42s freeze whenever the
// disk was busy (LOOP-FREEZE 2026-09-02, "daemon under load"). Now the named
// file gets one stat, and the tree walk that recovers coalesced siblings is
// throttled and asynchronous.
describe("RecursiveWatcher native event cost", () => {
  const isNative = process.platform === "darwin" || process.platform === "win32";

  function scaffold(prefix: string): { root: string; files: string[] } {
    const root = tmpDir(prefix);
    const files: string[] = [];
    for (const dir of ["proj-a", "proj-b", "proj-c"]) {
      fs.mkdirSync(path.join(root, dir, "sub"), { recursive: true });
      for (const name of ["one.jsonl", "two.jsonl"]) {
        const f = path.join(root, dir, name);
        fs.writeFileSync(f, "{}\n");
        files.push(f);
      }
      fs.writeFileSync(path.join(root, dir, "sub", "deep.jsonl"), "{}\n");
    }
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, files };
  }

  test.skipIf(!isNative)("an append probes only the named file; the tree walk waits for the throttle", async () => {
    const { root, files } = scaffold("rw-fastpath");
    const filtered: string[] = [];
    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => { filtered.push(rel); return rel.endsWith(".jsonl"); },
      callback: (p) => events.push(p),
      debounceMs: 30,
      rescanIntervalMs: 1_500,
    });
    cleanups.push(() => watcher.stop());
    watcher.start();
    await watcher.whenPrimed();
    // FSEvents replays the scaffold's own creation events just after the
    // watch opens; let them pass so the append below is not coalesced away.
    await new Promise((r) => setTimeout(r, 300));
    filtered.length = 0;

    fs.appendFileSync(files[0], '{"more": true}\n');
    await new Promise((r) => setTimeout(r, 300));

    // Emitted through the direct probe…
    expect(events).toContain(files[0]);
    // …without the filter (and so the walk) touching the other eight files.
    const walked = new Set(filtered);
    for (const other of files.slice(1)) expect(walked.has(path.relative(root, other))).toBe(false);

    // The safety-net rescan then walks the whole tree, once.
    await new Promise((r) => setTimeout(r, 1_600));
    expect(new Set(filtered).size).toBe(9);
    // And a change no event carried (mtime bumped in place) surfaces through it.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(files[3], later, later);
    await new Promise((r) => setTimeout(r, 1_900));
    expect(events).toContain(files[3]);
  });

  test("a burst of file events paces rescans from the previous walk's end and recovers missing events", async () => {
    const { root, files } = scaffold("rw-throttle");
    const epoch = Date.now() + 10_000;
    let now = epoch;
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const pending = new Set<Promise<unknown>>();
    const walks: Array<{ start: number; end: number }> = [];
    const events: string[] = [];
    let nativeEvent!: (type: string, filename: string | null) => void;
    const watcher = new RecursiveWatcher({
      path: root,
      mode: "native",
      filter: rel => rel.endsWith(".jsonl"),
      callback: file => events.push(file),
      debounceMs: 20,
      rescanIntervalMs: 800,
    });
    const internal = watcher as any;
    const runRescan = internal.runRescan.bind(watcher);
    const probe = internal.probe.bind(watcher);
    const walkTree = internal.walkTree.bind(watcher);
    const track = (promise: Promise<unknown>) => {
      pending.add(promise);
      return promise.finally(() => pending.delete(promise));
    };
    const spies = [
      spyOn(Date, "now").mockImplementation(() => now),
      spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms = 0) => {
        const id = ++timerId;
        timers.set(id, { at: now + ms, callback });
        return id;
      }) as typeof setTimeout),
      spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { timers.delete(id); }) as typeof clearTimeout),
      spyOn(fs, "watch").mockImplementation(((_root: string, _opts: unknown, callback: typeof nativeEvent) => {
        nativeEvent = callback;
        return Object.assign(new EventEmitter(), { close() {} });
      }) as typeof fs.watch),
      spyOn(internal, "runRescan").mockImplementation(() => track(runRescan())),
      spyOn(internal, "probe").mockImplementation((...args: unknown[]) => track(probe(...args))),
      spyOn(internal, "walkTree").mockImplementation(async (...args: unknown[]) => {
        const timing = { start: now - epoch, end: 0 };
        await walkTree(...args);
        if (args[1]) now += 125;
        timing.end = now - epoch;
        walks.push(timing);
      }),
    ];
    const advanceTo = async (elapsed: number) => {
      const target = epoch + elapsed;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = Math.max(now, next[1].at);
        timers.delete(next[0]);
        next[1].callback();
        await Promise.all([...pending]);
      }
      now = Math.max(now, target);
    };
    try {
      watcher.start();
      await watcher.whenPrimed();
      for (let i = 0; i < 20; i++) {
        const file = files[i % 2];
        fs.appendFileSync(file, `{"i": ${i}}\n`);
        const stamp = new Date(epoch + i + 1);
        fs.utimesSync(file, stamp, stamp);
        nativeEvent("change", path.relative(root, file));
        await advanceTo((i + 1) * 25);
      }
      expect(events).toContain(files[0]);
      expect(events).toContain(files[1]);
      expect(walks).toEqual([{ start: 0, end: 0 }]);
      nativeEvent("rename", null);
      const missed = files[3];
      const stamp = new Date(epoch + 5_000);
      fs.utimesSync(missed, stamp, stamp);
      await advanceTo(799);
      expect(events).not.toContain(missed);
      expect(walks).toHaveLength(1);
      await advanceTo(800);
      expect(events).toContain(missed);
      expect(walks).toEqual([{ start: 0, end: 0 }, { start: 800, end: 925 }]);
      const secondMissed = files[4];
      const secondStamp = new Date(epoch + 6_000);
      fs.utimesSync(secondMissed, secondStamp, secondStamp);
      await advanceTo(1_724);
      expect(events).not.toContain(secondMissed);
      expect(walks).toHaveLength(2);
      await advanceTo(1_725);
      expect(events).toContain(secondMissed);
      expect(walks).toEqual([{ start: 0, end: 0 }, { start: 800, end: 925 }, { start: 1_725, end: 1_850 }]);
      expect(walks.slice(1).map((walk, i) => walk.start - walks[i].end)).toEqual([800, 800]);
    } finally {
      watcher.stop();
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });

  test.skipIf(!isNative)("a write that lands while priming is still walking is not lost", async () => {
    // Big enough that priming outlasts the watch going live (~10ms).
    const root = tmpDir("rw-prime-race");
    for (let d = 0; d < 80; d++) {
      fs.mkdirSync(path.join(root, `p${d}`), { recursive: true });
      for (let f = 0; f < 40; f++) fs.writeFileSync(path.join(root, `p${d}`, `s${f}.jsonl`), "{}\n");
    }
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, "p79", "s39.jsonl");
    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => {
        // ~0.1ms per file keeps priming busy for a few hundred ms.
        const t = performance.now();
        while (performance.now() - t < 0.1) { /* spin */ }
        return rel.endsWith(".jsonl");
      },
      callback: (p) => events.push(p),
      debounceMs: 20,
    });
    cleanups.push(() => watcher.stop());
    watcher.start(); // start() creates the priming promise; observe it after
    let primedAt = 0;
    watcher.whenPrimed().then(() => { primedAt = Date.now(); });
    await new Promise((r) => setTimeout(r, 30));
    // The watch is open before the walk. Whether the walk stats this file
    // before or after the write, the event must produce an emit.
    const wroteAt = Date.now();
    fs.appendFileSync(target, '{"during": "priming"}\n');
    await watcher.whenPrimed();
    expect(primedAt).toBeGreaterThanOrEqual(wroteAt); // the race was real
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toContain(target);
  }, 60_000);

  test("onExisting receives every primed file with its stat, once", async () => {
    const { root } = scaffold("rw-existing");
    let seen: string[] | null = null;
    let calls = 0;
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: () => {},
      onExisting: (files) => { calls++; seen = files.map((f) => f.rel).sort(); },
    });
    cleanups.push(() => watcher.stop());
    watcher.start();
    await watcher.whenPrimed();
    if (!isNative) return; // chokidar path has no priming walk
    expect(calls).toBe(1);
    expect(seen).toHaveLength(9);
    expect(seen!).toContain(path.join("proj-a", "sub", "deep.jsonl"));
  });
});

// Priming a large tree must never pin the loop: the walk is async and batched,
// so between two readdir answers timers keep firing. 10k files is the order
// of one machine's transcript store.
describe("RecursiveWatcher priming a 10k file tree", () => {
  test("holds the loop under 100ms at a time and skips node_modules", async () => {
    const root = tmpDir("rw-10k");
    const DIRS = 400;
    const PER_DIR = 25;
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `proj-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < PER_DIR; f++) fs.writeFileSync(path.join(dir, `s${f}.jsonl`), "{}\n");
    }
    for (let d = 0; d < 40; d++) {
      const dir = path.join(root, "node_modules", `pkg-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < PER_DIR; f++) fs.writeFileSync(path.join(dir, `s${f}.jsonl`), "{}\n");
    }
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // The walk's own findings, not `filter` calls: on macOS the native watch
    // can replay the writes that happened just before it opened, and those
    // events go through `filter` too.
    let existing: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      dirFilter: (rel) => !rel.split(path.sep).includes("node_modules"),
      onExisting: (files) => { existing = files.map((f) => f.rel); },
      callback: () => {},
    });
    cleanups.push(() => watcher.stop());
    const { maxGapMs, ticks } = await measureLoopHold(async () => {
      watcher.start();
      await watcher.whenPrimed();
    });
    watcher.stop();

    expect(existing.length).toBe(DIRS * PER_DIR);
    expect(existing.some((rel) => rel.split(path.sep).includes("node_modules"))).toBe(false);
    expect(ticks).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(loopHoldBoundMs(100));
  }, 60_000);
});

// chokidar (the Linux path) asks `ignored` about files too, and before it has
// a stat. A dirFilter answers for directories only, so a file must be judged
// by the directory it sits in or every transcript is refused and the watcher
// only ever sees directory events.
describe("chokidarIgnored", () => {
  const UUID = "12345678-1234-1234-1234-123456789abc";
  const dirStats = { isDirectory: () => true } as fs.Stats;

  test("judges a file by its parent and a directory by itself", () => {
    const ignored = chokidarIgnored("/root", watchDirFilter);
    expect(ignored(`/root/slug/${UUID}.jsonl`)).toBe(false);
    expect(ignored(`/root/slug/${UUID}/subagents/agent-1.jsonl`)).toBe(false);
    expect(ignored(`/root/slug/${UUID}/tool-results`, dirStats)).toBe(true);
    expect(ignored(`/root/slug/${UUID}/tool-results/out.txt`)).toBe(true);
    // Without a stat a directory is judged by its parent; chokidar asks again
    // with the stat before it descends, and that is the ask that prunes it.
    expect(ignored(`/root/slug/${UUID}/tool-results`)).toBe(false);
    expect(ignored("/root")).toBe(false);
    expect(ignored("/elsewhere/x")).toBe(false);
  });

  // The production layouts, driven through a real chokidar watcher: every
  // transcript add event must arrive, and nothing from a pruned subtree.
  const layouts: Array<{ name: string; dirFilter: (rel: string) => boolean; depth: number; files: string[]; pruned: string }> = [
    { name: "claude", dirFilter: watchDirFilter, depth: 6, files: [`slug/${UUID}.jsonl`, `slug/${UUID}/subagents/agent-1.jsonl`], pruned: `slug/${UUID}/tool-results/out.txt` },
    { name: "codex", dirFilter: transcriptDirWatcherConfig("codex").dirFilter!, depth: transcriptDirWatcherConfig("codex").maxDepth!, files: ["2026/02/25/rollout-x.jsonl"], pruned: "scratch/rollout-y.jsonl" },
    { name: "gemini", dirFilter: transcriptDirWatcherConfig("gemini").dirFilter!, depth: transcriptDirWatcherConfig("gemini").maxDepth!, files: ["hash/chats/session-1.json"], pruned: "hash/checkpoints/c.json" },
    { name: "grok", dirFilter: transcriptDirWatcherConfig("grok").dirFilter!, depth: transcriptDirWatcherConfig("grok").maxDepth!, files: [`slug/${UUID}/turn.json`], pruned: "slug/.cwd/x.json" },
  ];

  test("every production watcher's transcript files reach chokidar's add event", async () => {
    // One watcher at a time: on macOS, several chokidar roots armed in the
    // same tick share one bun fs.watch pool and only one of them gets events.
    for (const { name, dirFilter, depth, files, pruned } of layouts) {
      const root = tmpDir(`rw-chok-${name}`);
      fs.mkdirSync(root, { recursive: true });
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const seen: string[] = [];
      const w = chokidarWatch(root, {
        persistent: true,
        ignoreInitial: true,
        depth,
        ignored: chokidarIgnored(root, dirFilter),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });
      cleanups.push(() => { void w.close(); });
      w.on("add", (p) => seen.push(path.relative(root, p)));
      await new Promise<void>((r) => w.once("ready", () => r()));
      // ready fires before the root's own fs.watch is armed; give it a beat.
      await new Promise((r) => setTimeout(r, 300));
      for (const rel of [...files, pruned]) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), "{}\n");
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && files.some((f) => !seen.includes(f))) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      await w.close();
      expect({ name, seen: seen.sort() }).toEqual({ name, seen: [...files].sort() });
    }
  }, 60_000);
});

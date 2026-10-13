/**
 * The maintainer as the daemon runs it: a long-lived timer whose target size
 * comes from recent create demand, and which must stop dead when the daemon
 * shuts down. The pool build is stubbed through the `maintain` option, so the
 * timer, the coalescing and the sizing are tested on a clock we control rather
 * than on a real `git worktree add`. manager.test.ts covers the real build.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../../test-helpers/codecastDir.js";
import { startPoolMaintainer } from "./maintainer.js";
import { recordWorkspaceCreate } from "./demand.js";

const calls: Array<{ repoRoot: string; size: number }> = [];
let release: (() => void) | null = null;

/** Stands in for maintainPool; blocks while `release` is set. */
async function fakeMaintain(repoRoot: string, size: number): Promise<void> {
  calls.push({ repoRoot, size });
  if (!release) return;
  await new Promise<void>((resolve) => {
    const prior = release;
    release = () => {
      resolve();
      release = prior;
    };
  });
}

const timers = jest as unknown as {
  useFakeTimers: () => void;
  useRealTimers: () => void;
  advanceTimersByTime: (ms: number) => void;
};

/** Let the tick's awaits settle. The stubbed build never touches a timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

let repoRoot: string;
let home: IsolatedCodecastDir;
const handles: Array<{ stop: () => Promise<void> }> = [];

beforeEach(() => {
  home = isolateCodecastDir();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pool-daemon-"));
  calls.length = 0;
  release = null;
});

afterEach(async () => {
  timers.useRealTimers();
  for (const h of handles.splice(0)) {
    try { await h.stop(); } catch {}
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
  home.restore();
});

describe("startPoolMaintainer — lifecycle on the daemon's clock", () => {
  test("ticks immediately, then once per period, and never again after stop()", async () => {
    timers.useFakeTimers();
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 30_000, watch: false });
    handles.push(h);

    await flush();
    expect(calls.length).toBe(1);

    timers.advanceTimersByTime(30_000);
    await flush();
    expect(calls.length).toBe(2);

    timers.advanceTimersByTime(90_000);
    await flush();
    expect(calls.length).toBe(5);

    await h.stop();
    timers.advanceTimersByTime(300_000);
    await flush();
    expect(calls.length).toBe(5);
  });

  test("stop() is idempotent", async () => {
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, watch: false });
    handles.push(h);
    await h.stop();
    await h.stop();
  });

  test("a tick that overruns its period does not stack up passes", async () => {
    timers.useFakeTimers();
    release = () => {};
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 1_000, watch: false });
    handles.push(h);

    await flush();
    expect(calls.length).toBe(1); // the first pass is still running

    // Five periods elapse while that pass is stuck.
    timers.advanceTimersByTime(5_000);
    await flush();
    expect(calls.length).toBe(1);

    // Releasing it runs exactly ONE coalesced catch-up pass, not five.
    release!();
    release = null;
    await flush();
    expect(calls.length).toBe(2);
  });
});

describe("startPoolMaintainer — the target size follows real demand", () => {
  test("a repo with no creates holds no slots", async () => {
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 60_000, watch: false });
    handles.push(h);
    await h.tickNow();
    expect(calls.at(-1)).toEqual({ repoRoot, size: 0 });
  });

  test("an isolated create still earns nothing; the second one arms a slot", async () => {
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 60_000, watch: false });
    handles.push(h);

    await recordWorkspaceCreate(repoRoot);
    await h.tickNow();
    expect(calls.at(-1)!.size).toBe(0);

    await recordWorkspaceCreate(repoRoot);
    await h.tickNow();
    expect(calls.at(-1)!.size).toBe(1);
  });

  test("a burst walks up to the cap the caller sets", async () => {
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 60_000, watch: false, maxSlots: 2 });
    handles.push(h);
    for (let i = 0; i < 6; i++) await recordWorkspaceCreate(repoRoot);
    await h.tickNow();
    expect(calls.at(-1)!.size).toBe(2);
  });

  test("a pinned size ignores demand entirely", async () => {
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, size: 2, periodMs: 60_000, watch: false });
    handles.push(h);
    await h.tickNow();
    expect(calls.at(-1)!.size).toBe(2);
  });
});

describe("startPoolMaintainer — re-arm after a claim in another process", () => {
  test("a create recorded by a CLI process wakes the maintainer", async () => {
    // One create already on the books, so the next one raises the target and
    // the maintainer has something to do when it wakes.
    await recordWorkspaceCreate(repoRoot);
    const h = startPoolMaintainer({ maintain: fakeMaintain, repoRoot, periodMs: 600_000 });
    handles.push(h);
    await h.tickNow();
    const before = calls.length;
    expect(calls.at(-1)!.size).toBe(0);

    // This is what `cast ws acquire` in a separate process writes.
    await recordWorkspaceCreate(repoRoot);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && calls.length === before) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)!.size).toBe(1);
  }, 10000);
});

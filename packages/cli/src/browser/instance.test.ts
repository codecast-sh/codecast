/**
 * Lifecycle safety for the SHARED managed browser.
 *
 * These tests pin the two mechanisms that ended the 2026-08-14 restart
 * stampede: a liveness probe that distinguishes "overloaded" from "gone"
 * (so agents stop killing a busy browser), and a launch lock that collapses
 * concurrent starts into one winner instead of a Chrome-singleton race.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { acquireStartLock, probeLiveness, readState, writeState, type InstanceState } from "./instance.js";
import { browserHome } from "./profile.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** Point CODECAST_DIR at a temp dir so nothing touches the real ~/.codecast. */
function isolatedHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-instance-test-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeState(overrides: Partial<InstanceState> = {}): InstanceState {
  return {
    pid: process.pid, // an alive pid, unless overridden
    port: 1, // nothing listens there, unless overridden
    userDataDir: "/tmp/nowhere",
    headless: true,
    sourceProfile: null,
    channel: "chrome",
    startedAt: Date.now(),
    activeTargetId: null,
    ...overrides,
  };
}

/** A loopback server that answers /json/version the way Chrome's CDP does. */
async function fakeCdp(): Promise<number> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:0/devtools/browser/x" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => srv.close());
  const addr = srv.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

describe("probeLiveness", () => {
  test("no state is dead", async () => {
    expect(await probeLiveness(null)).toBe("dead");
  });

  test("a dead pid is dead, immediately", async () => {
    // A pid from the ephemeral range that cannot be running.
    const started = Date.now();
    const res = await probeLiveness(fakeState({ pid: 2 ** 22 - 3 }));
    expect(res).toBe("dead");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("an alive pid whose CDP answers is live", async () => {
    const port = await fakeCdp();
    expect(await probeLiveness(fakeState({ port }))).toBe("live");
  });

  test("an alive pid whose CDP never answers is unresponsive, NOT dead", async () => {
    // This distinction is the whole point: "dead" licenses a relaunch that
    // kills the browser under every other agent; a busy browser must not
    // qualify. Port 1 refuses connections, standing in for a wedged CDP.
    expect(await probeLiveness(fakeState({ port: 1 }), 600)).toBe("unresponsive");
  });
});

describe("acquireStartLock", () => {
  test("serializes: a second acquire waits until release", async () => {
    isolatedHome();
    const release = await acquireStartLock();
    let secondHeld = false;
    const second = acquireStartLock(5000).then((rel) => {
      secondHeld = true;
      return rel;
    });
    // The second must not sneak in while the first is held.
    await new Promise((r) => setTimeout(r, 400));
    expect(secondHeld).toBe(false);
    release();
    const rel2 = await second;
    expect(secondHeld).toBe(true);
    rel2();
  });

  test("steals a lock whose holder is gone", async () => {
    isolatedHome();
    const lockFile = path.join(browserHome(), "start.lock");
    fs.mkdirSync(browserHome(), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 - 3, at: Date.now() }));
    const release = await acquireStartLock(2000);
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test("steals a lock held longer than any launch could take", async () => {
    isolatedHome();
    const lockFile = path.join(browserHome(), "start.lock");
    fs.mkdirSync(browserHome(), { recursive: true });
    // Holder is alive (us) but the stamp is ancient — a crashed-mid-launch
    // leftover must not wedge every future start on the machine.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000 }));
    const release = await acquireStartLock(2000);
    release();
  });

  test("gives up with a pointer at the lock file when the holder stays alive", async () => {
    isolatedHome();
    const release = await acquireStartLock();
    cleanups.push(release);
    await expect(acquireStartLock(700)).rejects.toThrow(/start\.lock/);
  });
});

describe("writeState", () => {
  test("round-trips and preserves every field, including remote", async () => {
    isolatedHome();
    const state = fakeState({
      remote: { host: "10.0.0.5", user: "agent", sshPid: 4242 },
      tabsBySession: { s1: "T1" },
      viewportByTab: { T1: { width: 390, height: 844, scale: 3, mobile: true } },
    });
    writeState(state);
    expect(readState()).toEqual(state);
    // No temp file left behind by the atomic rename.
    const leftovers = fs.readdirSync(browserHome()).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

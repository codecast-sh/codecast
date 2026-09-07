/**
 * The file that connects one short-lived CLI process to the next.
 *
 * Two hazards it exists for: a torn read, which a reader takes as "no helper
 * is running" and answers by launching a second one over the live one; and the
 * three-state liveness that keeps an overloaded helper from being killed by
 * every agent that finds it slow.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  acquireStartLock,
  clearInstance,
  instancePath,
  probeLiveness,
  readInstance,
  strayHelperPids,
  writeInstance,
  type ComputerInstanceState,
} from "./instance.js";
import { computerHome } from "./helperApp.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function isolatedHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-instance-test-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeState(overrides: Partial<ComputerInstanceState> = {}): ComputerInstanceState {
  return {
    pid: process.pid,
    socketPath: "/tmp/nowhere/helper.sock",
    socketDir: "/tmp/nowhere",
    token: "a".repeat(64),
    helperPath: "/nowhere/codecast computer.app",
    protocolVersion: 1,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("the instance file", () => {
  test("is written 0600 inside a 0700 directory and round-trips", () => {
    isolatedHome();
    const state = fakeState();
    writeInstance(state);
    expect(readInstance()).toEqual(state);
    expect(fs.statSync(instancePath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(computerHome()).mode & 0o777).toBe(0o700);
  });

  test("a torn or truncated file reads as absent, not as a throw", () => {
    isolatedHome();
    writeInstance(fakeState());
    fs.writeFileSync(instancePath(), '{"pid": 41321, "socketPa');
    expect(readInstance()).toBeNull();
  });

  test("a file with no token is refused: a helper we cannot authenticate to is no helper", () => {
    isolatedHome();
    fs.mkdirSync(computerHome(), { recursive: true });
    fs.writeFileSync(instancePath(), JSON.stringify({ pid: 1, socketPath: "/tmp/x.sock" }));
    expect(readInstance()).toBeNull();
  });

  test("clearing it is idempotent", () => {
    isolatedHome();
    writeInstance(fakeState());
    clearInstance();
    clearInstance();
    expect(readInstance()).toBeNull();
  });
});

describe("probeLiveness", () => {
  const never = async () => false;
  const always = async () => true;

  test("no file at all is dead", async () => {
    expect(await probeLiveness(null, always)).toBe("dead");
  });

  test("a pid that is gone is dead, however the socket behaves", async () => {
    // pid 1 is init; a pid far past the wrap point is reliably absent.
    expect(await probeLiveness(fakeState({ pid: 0x7ffffff0 }), always)).toBe("dead");
  });

  test("a live pid whose socket stays silent is unresponsive, not dead", async () => {
    // The distinction that ended the 2026-08-14 restart stampede: the caller
    // must not read this as permission to kill and relaunch.
    expect(await probeLiveness(fakeState(), never, 300)).toBe("unresponsive");
  });

  test("a socket that answers is live", async () => {
    expect(await probeLiveness(fakeState(), always)).toBe("live");
  });

  test("a socket that answers on a later attempt is still live", async () => {
    let attempts = 0;
    const slow = async () => ++attempts >= 3;
    expect(await probeLiveness(fakeState(), slow, 3_000)).toBe("live");
    expect(attempts).toBe(3);
  });
});

describe("acquireStartLock", () => {
  test("serializes two launches, and the loser proceeds once the winner is done", async () => {
    isolatedHome();
    const release = await acquireStartLock();
    let secondEntered = false;
    const second = acquireStartLock(5_000).then((rel) => {
      secondEntered = true;
      rel();
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(secondEntered).toBe(false);
    release();
    await second;
    expect(secondEntered).toBe(true);
  });

  test("a lock whose holder is gone is reclaimed rather than waited out", async () => {
    isolatedHome();
    fs.mkdirSync(computerHome(), { recursive: true });
    fs.writeFileSync(path.join(computerHome(), "start.lock"), JSON.stringify({ pid: 0x7ffffff0, at: Date.now() }));
    const release = await acquireStartLock(2_000);
    release();
  });
});

describe("strayHelperPids", () => {
  test("finds a helper by its socket directory, despite the pattern starting with --", async () => {
    const socketDir = path.join(os.tmpdir(), `codecast-computer-stray-${process.pid}`);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)", "--agent", `${socketDir}/helper.sock`], { stdio: "ignore" });
    cleanups.push(() => child.kill("SIGKILL"));
    await new Promise((r) => setTimeout(r, 400));
    // Without the `--` before the pattern pgrep reads `--agent` as an option
    // and silently finds nothing, which reads as "no strays" forever.
    expect(strayHelperPids(socketDir)).toContain(child.pid!);
  });

  test("returns nothing when no helper holds the directory", () => {
    expect(strayHelperPids(path.join(os.tmpdir(), "codecast-computer-nobody-here"))).toEqual([]);
  });
});

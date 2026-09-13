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
import { acquireStartLock, probeLiveness, readState, strayPids, writeState, type InstanceState, chromeLaunchArgs} from "./instance.js";
import { authorizesTeardown } from "@codecast/shared/contracts";
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
  test("no state is exited", async () => {
    expect(await probeLiveness(null)).toBe("exited");
  });

  test("a dead pid is exited, immediately", async () => {
    // A pid from the ephemeral range that cannot be running.
    const started = Date.now();
    const res = await probeLiveness(fakeState({ pid: 2 ** 22 - 3 }));
    expect(res).toBe("exited");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("an alive pid whose CDP answers is live", async () => {
    const port = await fakeCdp();
    expect(await probeLiveness(fakeState({ port }))).toBe("live");
  });

  test("an alive pid whose CDP never answers is unverifiable, NOT exited", async () => {
    // This distinction is the whole point: only `exited` licenses a relaunch,
    // and that relaunch kills the browser under every other agent; a busy
    // browser must not qualify. Port 1 refuses connections, standing in for a
    // wedged CDP.
    expect(await probeLiveness(fakeState({ port: 1 }), 600)).toBe("unverifiable");
  });

  // The verdicts above in the terms every caller reads them through, so the
  // rename to the shared vocabulary cannot quietly change who may relaunch.
  test("only a browser observed gone authorizes a relaunch", async () => {
    const port = await fakeCdp();
    expect(authorizesTeardown(await probeLiveness(null))).toBe(true);
    expect(authorizesTeardown(await probeLiveness(fakeState({ pid: 2 ** 22 - 3 })))).toBe(true);
    expect(authorizesTeardown(await probeLiveness(fakeState({ port })))).toBe(false);
    expect(authorizesTeardown(await probeLiveness(fakeState({ port: 1 }), 600))).toBe(false);
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

  test("releases the lock when the process exits via process.exit", async () => {
    // The CLI reports every error through a helper that calls process.exit,
    // and process.exit does NOT run `finally` — so the obvious
    // try/finally release never fired on a failed launch. Verified in a real
    // child process, because that is the only way to observe a real exit.
    const dir = isolatedHome();
    const script = path.join(dir, "holder.mjs");
    const mod = path.join(import.meta.dir, "instance.ts");
    fs.writeFileSync(
      script,
      `import { acquireStartLock } from ${JSON.stringify(mod)};\n` +
        `await acquireStartLock();\n` +
        `process.exit(1);\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, CODECAST_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);

    const lockFile = path.join(browserHome(), "start.lock");
    expect(fs.existsSync(lockFile)).toBe(false);
    // And the lock is genuinely free, not merely reclaimed later as stale:
    // taking it must be immediate rather than waiting out the staleness window.
    const started = Date.now();
    const release = await acquireStartLock(2000);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
  });

  test("releases the lock on SIGTERM, and still dies by the signal", async () => {
    // Node's default disposition for these terminates WITHOUT running `exit`
    // listeners, so the exit-handler release above does not cover them — and
    // agents routinely wrap these commands in `timeout`, which sends SIGTERM.
    const dir = isolatedHome();
    const script = path.join(dir, "hang.mjs");
    const mod = path.join(import.meta.dir, "instance.ts");
    fs.writeFileSync(
      script,
      `import { acquireStartLock } from ${JSON.stringify(mod)};\n` +
        `await acquireStartLock();\n` +
        `console.log("acquired");\n` +
        `await new Promise(() => {});\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...process.env, CODECAST_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 4000);
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (!output.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();
      expect(output).toBe("acquired\n");
      const lockFile = path.join(browserHome(), "start.lock");
      expect(fs.existsSync(lockFile)).toBe(true);

      proc.kill("SIGTERM");
      await proc.exited;
      expect(fs.existsSync(lockFile)).toBe(false);
      // Re-raised rather than swallowed: the process must still die by the
      // signal (128 + 15), so callers and shells see what they expect.
      expect(proc.exitCode === 143 || proc.signalCode === "SIGTERM").toBe(true);
    } finally {
      clearTimeout(deadline);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  test("reports who it is waiting for instead of blocking silently", async () => {
    isolatedHome();
    const release = await acquireStartLock();
    cleanups.push(release);
    const waitedOn: number[] = [];
    await expect(acquireStartLock(700, (pid) => waitedOn.push(pid))).rejects.toThrow();
    // Announced once, naming the holder — a silent block reads as a hang, and
    // an agent's answer to a hang is to kill and retry.
    expect(waitedOn).toEqual([process.pid]);
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

describe("chromeLaunchArgs", () => {
  const base = { userDataDir: "/tmp/x", port: 9222 };

  test("fake media adds both Chrome flags: fake devices AND auto-accepted prompt", () => {
    const args = chromeLaunchArgs({ ...base, fakeMedia: true });
    expect(args).toContain("--use-fake-device-for-media-stream");
    expect(args).toContain("--use-fake-ui-for-media-stream");
  });

  test("a normal launch carries neither", () => {
    const args = chromeLaunchArgs(base);
    expect(args.some((a) => a.includes("fake"))).toBe(false);
  });

  test("a home without a login keychain launches with the mock keychain", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-kc-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const args = chromeLaunchArgs(base);
      expect(args.includes("--use-mock-keychain")).toBe(process.platform === "darwin");
    } finally {
      process.env.HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("background tabs retain Chrome's timer throttling", () => {
    const args = chromeLaunchArgs(base);
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).not.toContain("--disable-background-timer-throttling");
  });
});

describe("strayPids", () => {
  test("a profile nobody holds has no strays, including the lookup's own shell", () => {
    // Running pgrep through a shell puts the pattern in that shell's argv, so
    // the lookup matches itself: `killStrays` then shoots its own shell and
    // `waitForStraysGone` never reaches zero. macOS hides it (its `sh` execs a
    // lone simple command and is gone); Debian's `sh` stays (ct-49945).
    expect(strayPids(path.join(os.tmpdir(), "codecast-chrome-nobody-here"))).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withPortReservations } from "./portReservations.js";
import { acquireLock, releaseLock } from "../capabilities/lock.js";

let root: string;
let directory: string;
let lock: string;
let previousCodecastDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-reservation-lock-"));
  previousCodecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(root, "host-state");
  directory = path.join(process.env.CODECAST_DIR, "workspace-ports");
  fs.mkdirSync(directory, { recursive: true });
  lock = path.join(directory, ".codecast-capability.lock");
});

afterEach(() => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousCodecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = previousCodecastDir;
});

function expireWait() {
  return spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("reservation-specific lock", () => {
  test("publishes complete owner metadata atomically and removes the temporary file", async () => {
    const linkSync = fs.linkSync;
    const publish = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      expect(destination).toBe(lock);
      expect(fs.existsSync(lock)).toBe(false);
      const owner = JSON.parse(fs.readFileSync(source, "utf8"));
      expect(owner.pid).toBe(process.pid);
      expect(owner.pid).toBeGreaterThan(0);
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/);
      linkSync(source, destination);
      expect(fs.readFileSync(destination, "utf8")).toBe(fs.readFileSync(source, "utf8"));
    });
    expect(await withPortReservations(root, async () => {
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      return "reserved";
    })).toBe("reserved");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory)).toEqual(["repositories.json"]);
  });

  test.each([
    ["empty", ""],
    ["partial JSON", '{"pid":'],
    ["null", "null"],
    ["zero PID", JSON.stringify({ pid: 0, token: "holder" })],
    ["negative PID", JSON.stringify({ pid: -1, token: "holder" })],
    ["missing token", JSON.stringify({ pid: process.pid })],
    ["empty token", JSON.stringify({ pid: process.pid, token: "" })],
    ["invalid group", JSON.stringify({ pid: process.pid, pgid: "x", token: "holder" })],
    ["invalid start time", JSON.stringify({ pid: process.pid, pgid: 1, started: 5, token: "holder" })],
  ])("does not reclaim a lock with %s metadata", async (_label, contents) => {
    fs.writeFileSync(lock, contents!);
    const inode = fs.statSync(lock).ino;
    const callback = mock(async () => "entered");
    const kill = spyOn(process, "kill");
    expireWait();
    await expect(withPortReservations(root, callback)).rejects.toThrow(`inspect ${lock}`);
    expect(callback).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(fs.statSync(lock).ino).toBe(inode);
    expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    expect(fs.readdirSync(directory)).toEqual([path.basename(lock)]);
  });

  test("an unreadable owner is busy and retained", async () => {
    fs.mkdirSync(lock);
    const callback = mock(async () => "entered");
    expireWait();
    await expect(withPortReservations(root, callback)).rejects.toThrow("unreadable owner");
    expect(callback).not.toHaveBeenCalled();
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  test("unknown PID liveness fails closed", async () => {
    const contents = JSON.stringify({ pid: process.pid, token: "holder" });
    fs.writeFileSync(lock, contents);
    spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    const callback = mock(async () => "entered");
    expireWait();
    await expect(withPortReservations(root, callback)).rejects.toThrow(`pid ${process.pid}`);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lock, "utf8")).toBe(contents);
  });

  test("waits at most 30 seconds for a live owner without reentrancy or age-based reclaim", async () => {
    await withPortReservations(root, async () => {
      const contents = fs.readFileSync(lock, "utf8");
      const callback = mock(async () => "entered");
      const clock = expireWait();
      try {
        await expect(withPortReservations(root, callback)).rejects.toThrow("Timed out waiting for workspace port reservations");
        expect(callback).not.toHaveBeenCalled();
        expect(fs.readFileSync(lock, "utf8")).toBe(contents);
      } finally {
        clock.mockRestore();
      }
    });
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("live concurrent holders in one process enter only after the previous holder releases", async () => {
    const entered: number[] = [];
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const secondEntered = deferred();
    const first = withPortReservations(root, async () => {
      entered.push(1);
      await releaseFirst.promise;
    });
    const second = withPortReservations(root, async () => {
      entered.push(2);
      secondEntered.resolve();
      await releaseSecond.promise;
    });
    try {
      expect(entered).toEqual([1]);
      releaseFirst.resolve();
      await first;
      await secondEntered.promise;
      expect(entered).toEqual([1, 2]);
      expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid).toBe(process.pid);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("a separate live process cannot enter until the holder releases", async () => {
    const release = deferred();
    const first = withPortReservations(root, () => release.promise);
    const child = Bun.spawn([process.execPath, "-e", `
      import { withPortReservations } from ${JSON.stringify(path.join(import.meta.dir, "portReservations.ts"))};
      const pending = withPortReservations(${JSON.stringify(root)}, async () => {
        console.log("entered");
      });
      console.log("attempted");
      await pending;
    `], { stdout: "pipe", stderr: "pipe", env: process.env });
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    try {
      const attempt = await reader.read();
      expect(new TextDecoder().decode(attempt.value)).toBe("attempted\n");
      expect(JSON.parse(fs.readFileSync(lock, "utf8")).pid).toBe(process.pid);
      release.resolve();
      await first;
      let remaining = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remaining += new TextDecoder().decode(chunk.value);
      }
      expect(remaining).toBe("entered\n");
      expect(await child.exited).toBe(0);
      expect(await stderr).toBe("");
    } finally {
      release.resolve();
      await first;
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  /** A process that led its own group (as a station does) and has exited. */
  async function deadLeader(): Promise<number> {
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore", detached: true });
    expect(await child.exited).toBe(0);
    return child.pid;
  }

  test("a dead owner that led its group and left nothing running is reclaimed, and the caller enters", async () => {
    const pid = await deadLeader();
    fs.writeFileSync(lock, JSON.stringify({ pid, pgid: pid, token: "dead-holder" }));
    expect(await withPortReservations(root, async () => JSON.parse(fs.readFileSync(lock, "utf8")).pid)).toBe(process.pid);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual(["repositories.json"]);
  });

  test("a dead owner whose lock names no group (an older cast's) fails closed with its path for manual recovery", async () => {
    const pid = await deadLeader();
    const contents = JSON.stringify({ pid, token: "dead-holder" });
    fs.writeFileSync(lock, contents);
    const callback = mock(async () => "entered");
    await expect(withPortReservations(root, callback)).rejects.toThrow(`Workspace port reservations have an interrupted owner (pid ${pid}); inspect remaining child processes before manually removing ${lock}`);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lock, "utf8")).toBe(contents);
  });

  test("a dead owner whose child still runs in its group fails closed with its path for manual recovery", async () => {
    // The owner leads its group (as a station does) and exits, leaving a child running in that group.
    const owner = Bun.spawn(["/bin/bash", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { stdout: "pipe", stderr: "ignore", detached: true });
    const survivor = Number((await new Response(owner.stdout).text()).trim());
    await owner.exited;
    try {
      const contents = JSON.stringify({ pid: owner.pid, pgid: owner.pid, token: "dead-holder" });
      fs.writeFileSync(lock, contents);
      const callback = mock(async () => "entered");
      await expect(withPortReservations(root, callback)).rejects.toThrow(`inspect remaining child processes before manually removing ${lock}`);
      expect(callback).not.toHaveBeenCalled();
      expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    } finally {
      process.kill(survivor, "SIGKILL");
    }
  });

  /** Run `fn` as if on `platform`: the orphan scan's soundness is the platform's, so each branch runs on any OS. */
  async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...real, value: platform });
    try { return await fn(); } finally { Object.defineProperty(process, "platform", real); }
  }

  /** A living group whose member `inner` runs and exits; the owner's pid, and the pid of what it left (if anything). */
  async function deadMemberOfLivingGroup(inner: string) {
    const leader = Bun.spawn(["/bin/bash", "-c", `bash -c '${inner}'; exec sleep 60 >/dev/null`], { stdout: "pipe", stderr: "ignore", detached: true });
    const reader = leader.stdout.getReader();
    const [ownerPid, leftPid] = new TextDecoder().decode((await reader.read()).value).trim().split(/\s+/).map(Number);
    reader.releaseLock();
    for (let i = 0; i < 200; i++) {
      try { process.kill(ownerPid, 0); } catch { break; }
      await Bun.sleep(25);
    }
    const parentOf = (pid: number) => Number(Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim());
    return { leader, ownerPid, leftParent: leftPid ? parentOf(leftPid) : undefined };
  }

  test("a dead owner inside another's living group that left no orphan is reclaimed where orphans go to launchd", async () => {
    const { leader, ownerPid } = await deadMemberOfLivingGroup("echo $$");
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: ownerPid, pgid: leader.pid, token: "dead-holder" }));
      expect(await onPlatform("darwin", () => withPortReservations(root, async () => "entered"))).toBe("entered");
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      process.kill(-leader.pid, "SIGKILL");
    }
  });

  test("a dead owner inside another's living group that left an orphan fails closed", async () => {
    const { leader, ownerPid, leftParent } = await deadMemberOfLivingGroup("sleep 60 >/dev/null 2>&1 & echo $$ $!");
    try {
      // The scan reads an orphan as a member init adopted; where a subreaper adopted it instead the premise does not
      // hold, which is why off macOS the scan is never trusted (the test below).
      if (leftParent !== 1) return;
      const contents = JSON.stringify({ pid: ownerPid, pgid: leader.pid, token: "dead-holder" });
      fs.writeFileSync(lock, contents);
      const callback = mock(async () => "entered");
      await expect(onPlatform("darwin", () => withPortReservations(root, callback))).rejects.toThrow("interrupted owner");
      expect(callback).not.toHaveBeenCalled();
      expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    } finally {
      process.kill(-leader.pid, "SIGKILL");
    }
  });

  test("off macOS a dead owner inside another's living group fails closed even with no orphan: a subreaper may hold it", async () => {
    const { leader, ownerPid } = await deadMemberOfLivingGroup("echo $$");
    try {
      const contents = JSON.stringify({ pid: ownerPid, pgid: leader.pid, token: "dead-holder" });
      fs.writeFileSync(lock, contents);
      await expect(onPlatform("linux", () => withPortReservations(root, async () => "entered"))).rejects.toThrow("interrupted owner");
      expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    } finally {
      process.kill(-leader.pid, "SIGKILL");
    }
  });

  test("an owner whose pid now names a process started at another time is gone, and its lock is reclaimed", async () => {
    // This process stands in for whatever was handed the dead owner's pid; the owner's own group is gone.
    const group = await deadLeader();
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, pgid: group, started: "Mon Jan 1 00:00:00 2001", token: "dead-holder" }));
    expect(await onPlatform("darwin", () => withPortReservations(root, async () => "entered"))).toBe("entered");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("an owner alive since the start time its lock records keeps it", async () => {
    await withPortReservations(root, async () => {
      const contents = fs.readFileSync(lock, "utf8");
      const clock = expireWait();
      try {
        await expect(withPortReservations(root, async () => "entered")).rejects.toThrow("Timed out waiting for workspace port reservations");
      } finally {
        clock.mockRestore();
      }
      expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    });
  });

  test("records the owner's process group and start time in one form, whatever the owner's locale and timezone", async () => {
    // A fresh process, since an owner reads its identity once, started far from UTC and outside the C locale; it holds
    // the lock until told to let go, so its start can be read back while it lives.
    const child = Bun.spawn([process.execPath, "-e", `
      import { withPortReservations } from ${JSON.stringify(path.join(import.meta.dir, "portReservations.ts"))};
      import * as fs from "node:fs";
      await withPortReservations(${JSON.stringify(root)}, async () => {
        console.log(fs.readFileSync(${JSON.stringify(lock)}, "utf8"));
        for await (const _ of console) break;
      });
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, TZ: "Pacific/Kiritimati", LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" } });
    try {
      const reader = child.stdout.getReader();
      const owner = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
      reader.releaseLock();
      const [pgid, ...started] = Bun.spawnSync(["ps", "-o", "pgid=,lstart=", "-p", String(child.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.toString().trim().split(/\s+/);
      expect(owner.pid).toBe(child.pid);
      expect(owner.pgid).toBe(Number(pgid));
      expect(owner.started).toBe(started.join(" "));
    } finally {
      child.stdin.write("done\n");
      child.stdin.end();
      await child.exited;
    }
  });

  test("an owner's start time is compared in UTC, so a caller elsewhere still sees the same owner", async () => {
    await withPortReservations(root, async () => {
      const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
      const [pgid, ...started] = Bun.spawnSync(["ps", "-o", "pgid=,lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.toString().trim().split(/\s+/);
      expect(owner.pgid).toBe(Number(pgid));
      expect(owner.started).toBe(started.join(" "));
    });
  });

  test("callback exceptions release only the acquired lock", async () => {
    const failure = new Error("reservation failed");
    await expect(withPortReservations(root, async () => { throw failure; })).rejects.toBe(failure);
    expect(fs.existsSync(lock)).toBe(false);
    expect(await withPortReservations(root, async () => "retry")).toBe("retry");
  });

  test("reservation read exceptions release the acquired lock", async () => {
    fs.writeFileSync(path.join(directory, "repositories.json"), "{broken");
    const callback = mock(async () => "entered");
    await expect(withPortReservations(root, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("release retains another token even when its PID is the same", async () => {
    const replacement = JSON.stringify({ pid: process.pid, token: "different-operation" });
    await withPortReservations(root, async () => {
      fs.writeFileSync(lock, replacement);
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(replacement);
  });

  test("release retains unreadable ownership", async () => {
    await withPortReservations(root, async () => {
      fs.writeFileSync(lock, "");
    });
    expect(fs.readFileSync(lock, "utf8")).toBe("");
  });

  test("publication errors clean up the temporary file without entering", async () => {
    const failure = Object.assign(new Error("link denied"), { code: "EACCES" });
    spyOn(fs, "linkSync").mockImplementation(() => { throw failure; });
    const callback = mock(async () => "entered");
    await expect(withPortReservations(root, callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  test.each(["", JSON.stringify({ pid: process.pid, acquired_at: new Date(0).toISOString() })])(
    "refuses an existing legacy lock without reclaiming it: %s",
    async (contents) => {
      const legacy = path.join(directory, ".codecast-capability.lock");
      fs.writeFileSync(legacy, contents);
      const callback = mock(async () => "entered");
      expireWait();
      await expect(withPortReservations(root, callback)).rejects.toThrow("Timed out waiting for workspace port reservations");
      expect(callback).not.toHaveBeenCalled();
      expect(fs.readFileSync(legacy, "utf8")).toBe(contents);
      expect(fs.readdirSync(directory)).toEqual([path.basename(legacy)]);
    },
  );
  test("shares the legacy lock namespace during rolling upgrades", async () => {
    expect(acquireLock(directory).acquired).toBe(true);
    const clock = expireWait();
    try {
      await expect(withPortReservations(root, async () => "wrong")).rejects.toThrow("Timed out");
    } finally {
      clock.mockRestore();
      releaseLock(directory);
    }
    await withPortReservations(root, async () => {
      const log = mock(() => {});
      expect(acquireLock(directory, log).acquired).toBe(false);
      expect(log).not.toHaveBeenCalled();
    });
    expect(fs.existsSync(lock)).toBe(false);
  });

});

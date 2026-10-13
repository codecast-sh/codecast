import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acquireFileLock } from "./lockFile.js";

// The lock's whole job is exclusivity, and the way it used to lose it was
// subtle: create/write/close is three syscalls, so the winner of the O_EXCL
// race publishes an EMPTY file for a moment, and a loser that read that file as
// "no pid, therefore stale" would delete a LIVE holder's lock and take its own.
// A 4-process 15-round stress reproduced it 4 times while ct-49529 was wiring
// the reset-credit ledger onto this lock. These tests pin the three behaviours
// that fix has to keep straight: wait for a holder mid-write, still reclaim a
// real corpse, and never hand the lock to two callers at once.
let dir: string;
let lock: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
  lock = path.join(dir, "x.lock");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Out of range for a live process on any platform we run on.
const DEAD_PID = 2_147_483_646;

describe("acquireFileLock", () => {
  it("never hands the lock to two callers at once", async () => {
    const release = await acquireFileLock(lock, { waitMs: 10_000 });
    let secondTook = false;
    const second = acquireFileLock(lock, { waitMs: 10_000 }).then((r) => {
      secondTook = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(secondTook).toBe(false);
    release();
    (await second)();
    expect(secondTook).toBe(true);
  });

  it("waits out a holder that has not written its stamp yet", async () => {
    // Exactly what the winner's file looks like between open and write.
    fs.writeFileSync(lock, "");
    const started = Date.now();
    const release = await acquireFileLock(lock, { waitMs: 10_000 });
    release();
    // Only reclaimed once the file aged past the mid-write grace — a steal
    // would have returned in single-digit milliseconds.
    expect(Date.now() - started).toBeGreaterThan(1_000);
  });

  it("still reclaims a holder that was killed without releasing", async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, at: Date.now() }));
    const started = Date.now();
    const release = await acquireFileLock(lock, { waitMs: 10_000 });
    release();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("still reclaims a lock whose holder outlived staleMs", async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }));
    const release = await acquireFileLock(lock, { waitMs: 10_000, staleMs: 1_000 });
    release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("gives up with a message naming the holder and the file", async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(
      acquireFileLock(lock, { waitMs: 200, staleMs: 60_000, describe: "cast browser start" }),
    ).rejects.toThrow(/cast browser start.*has held .*x\.lock/s);
  });
});

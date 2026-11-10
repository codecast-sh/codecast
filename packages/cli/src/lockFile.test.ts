import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { acquireFileLock, withFileLockSync } from "./lockFile.js";

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

describe("withFileLockSync", () => {
  it("runs the section and releases", () => {
    expect(withFileLockSync(lock, () => fs.existsSync(lock))).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reclaims a holder that was killed without releasing", () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, at: Date.now() }));
    expect(withFileLockSync(lock, () => 7)).toBe(7);
    expect(fs.existsSync(lock)).toBe(false);
  });

  // The age bound is the documented rule for both variants: it is what frees a
  // lock whose dead holder's pid has been reused by an unrelated process.
  it("reclaims a lock whose holder outlived staleMs", () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }));
    expect(withFileLockSync(lock, () => 7, { staleMs: 1_000 })).toBe(7);
  });

  it("names a live holder's pid when it gives up", () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(() => withFileLockSync(lock, () => 7, { waitMs: 50 })).toThrow(new RegExp(`pid ${process.pid}\\) has held .*x\\.lock`));
  });

  it("does not call a half-written lock 'pid young' when it gives up", () => {
    fs.writeFileSync(lock, ""); // the winner's file between open and write
    let message = "";
    try {
      withFileLockSync(lock, () => 7, { waitMs: 50 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("holder stamp is not written yet");
    expect(message).not.toContain("young");
    expect(fs.existsSync(lock)).toBe(true); // waited for it, did not steal it
  });
});

// A holder that lost its lock to the staleness bound is still running, and its
// release used to unlink whatever sat at the path: the lock of the process that
// took over.
describe("release after losing the lock", () => {
  const successor = JSON.stringify({ pid: process.pid, at: Date.now(), token: "successor" });

  it("acquireFileLock's release leaves a successor's lock alone", async () => {
    const release = await acquireFileLock(lock);
    fs.writeFileSync(lock, successor);
    release();
    expect(fs.readFileSync(lock, "utf-8")).toBe(successor);
  });

  it("withFileLockSync's release leaves a successor's lock alone", () => {
    withFileLockSync(lock, () => fs.writeFileSync(lock, successor));
    expect(fs.readFileSync(lock, "utf-8")).toBe(successor);
  });
});

describe("reclaiming an abandoned lock", () => {
  const corpse = () => JSON.stringify({ pid: DEAD_PID, at: Date.now() });
  const leftovers = () => fs.readdirSync(dir).filter((f) => f !== "x.lock");

  it("leaves the reclaim to a waiter that is already doing it", async () => {
    fs.writeFileSync(lock, corpse());
    // Another live waiter is between its judgement and its removal.
    fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: process.pid, at: Date.now(), token: "other" }));
    await expect(acquireFileLock(lock, { waitMs: 100 })).rejects.toThrow(/could not be reclaimed/);
    expect(() => withFileLockSync(lock, () => 7, { waitMs: 50 })).toThrow(/could not be reclaimed/);
    expect(JSON.parse(fs.readFileSync(lock, "utf-8")).pid).toBe(DEAD_PID);
    expect(fs.existsSync(`${lock}.break`)).toBe(true);
  });

  it("clears the claim of a waiter that died mid-reclaim", async () => {
    fs.writeFileSync(lock, corpse());
    fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: DEAD_PID, at: Date.now(), token: "dead" }));
    const release = await acquireFileLock(lock, { waitMs: 5_000 });
    expect(leftovers()).toEqual([]);
    release();
    fs.writeFileSync(lock, corpse());
    fs.writeFileSync(`${lock}.break`, JSON.stringify({ pid: DEAD_PID, at: Date.now(), token: "dead" }));
    expect(withFileLockSync(lock, () => leftovers(), { waitMs: 5_000 })).toEqual([]);
  });

  // The race this pins: two waiters both judge the same lock abandoned; the
  // first removes it and creates its own, then the second removes "the stale
  // lock", which is now the first one's live lock, and both hold it. Every
  // holder here leaves a corpse instead of releasing, so every acquisition by
  // every process is a reclaim raced by all the others.
  const worker = (mode: "async" | "sync") => `
    import * as fs from "node:fs";
    import { acquireFileLock, withFileLockSync } from ${JSON.stringify(path.join(import.meta.dir, "lockFile.ts"))};
    const [lock, rounds] = [process.argv[2], Number(process.argv[3])];
    const marker = lock + ".held";
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const section = () => {
      try {
        fs.closeSync(fs.openSync(marker, "wx"));
      } catch {
        fs.appendFileSync(lock + ".violations", process.pid + "\\n");
        return;
      }
      Atomics.wait(nap, 0, 0, 2);
      fs.unlinkSync(marker);
      // Die holding it, as far as anyone else can tell.
      fs.writeFileSync(lock, JSON.stringify({ pid: ${DEAD_PID}, at: Date.now() }));
    };
    for (let i = 0; i < rounds; i++) {
      if (${JSON.stringify(mode)} === "sync") withFileLockSync(lock, section, { waitMs: 60_000 });
      else { await acquireFileLock(lock, { waitMs: 60_000 }); section(); }
    }
  `;

  for (const mode of ["async", "sync"] as const) {
    it(`gives a corpse to one waiter at a time (${mode}, 6 processes)`, async () => {
      const script = path.join(dir, "worker.ts");
      fs.writeFileSync(script, worker(mode));
      fs.writeFileSync(lock, corpse());
      const exits = await Promise.all(
        Array.from({ length: 6 }, () =>
          new Promise<string>((resolve) => {
            const child = spawn(process.execPath, [script, lock, "40"], { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (d) => (stderr += d));
            child.on("close", (code) => resolve(code === 0 ? "ok" : `exit ${code}: ${stderr}`));
          }),
        ),
      );
      expect(exits).toEqual(Array(6).fill("ok"));
      expect(fs.existsSync(`${lock}.violations`)).toBe(false);
    }, 120_000);
  }
});

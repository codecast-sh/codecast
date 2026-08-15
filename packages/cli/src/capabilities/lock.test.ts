import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acquireLock, releaseLock, withLock, LOCK_CEILING_MS } from "./lock.js";

const dirs: string[] = [];
function root(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lock-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const lockFile = (r: string) => path.join(r, ".codecast-capability.lock");

describe("acquireLock", () => {
  test("acquire, hold against self-alike, release", () => {
    const r = root();
    expect(acquireLock(r).acquired).toBe(true);
    // A second acquire from the SAME live pid is refused — the lock does not
    // know callers apart, and reentrancy would hide a double-writer bug.
    const second = acquireLock(r);
    expect(second.acquired).toBe(false);
    expect(second.heldBy?.pid).toBe(process.pid);
    releaseLock(r);
    expect(acquireLock(r).acquired).toBe(true);
  });

  test("a lock whose pid is gone is reclaimed with a log line", () => {
    const r = root();
    fs.writeFileSync(
      lockFile(r),
      JSON.stringify({ pid: 999999999, acquired_at: new Date().toISOString() }),
    );
    const lines: string[] = [];
    const result = acquireLock(r, (l) => lines.push(l));
    expect(result.acquired).toBe(true);
    expect(result.reclaimedFrom?.pid).toBe(999999999);
    expect(lines.join("\n")).toContain("reclaiming stale lock");
  });

  test("a live-pid lock past the ceiling is reclaimed — pids get recycled", () => {
    const r = root();
    fs.writeFileSync(
      lockFile(r),
      JSON.stringify({
        pid: process.pid, // alive, but the timestamp is ancient
        acquired_at: new Date(Date.now() - LOCK_CEILING_MS - 1000).toISOString(),
      }),
    );
    expect(acquireLock(r, () => {}).acquired).toBe(true);
  });

  test("an unreadable lock file is stale by definition", () => {
    const r = root();
    fs.writeFileSync(lockFile(r), "{corrupt");
    expect(acquireLock(r, () => {}).acquired).toBe(true);
  });

  test("release only removes our own lock", () => {
    const r = root();
    fs.writeFileSync(
      lockFile(r),
      JSON.stringify({ pid: 999999999, acquired_at: new Date().toISOString() }),
    );
    releaseLock(r);
    expect(fs.existsSync(lockFile(r))).toBe(true);
  });
});

describe("withLock", () => {
  test("runs the fn and releases even on throw", () => {
    const r = root();
    expect(() =>
      withLock(r, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lockFile(r))).toBe(false);
  });

  test("returns held-by when the lock is busy", () => {
    const r = root();
    acquireLock(r);
    const res = withLock(r, () => 42);
    expect(res.ok).toBe(false);
    releaseLock(r);
  });
});

// One writer at a time per target root.
//
// No lock existed, so two daemons — or a daemon and a `cast` invocation — could
// interleave read-merge-write on the same settings.json and clobber each other.
// One lock per TARGET ROOT (not per file): a capability apply touches several
// files under one root as a unit, and per-file locks would deadlock two
// processes acquiring in different orders.
//
// Reclaim is not optional. A stale lock that wedges every capability write on
// the machine silently and forever is worse than the race the lock prevents,
// so a lock whose pid is gone, or whose age is past a fixed ceiling, is
// reclaimed with a logged line saying whose it was.
//
// NEVER hold the lock across a network call: fetch first, lock, write, release.
// The ceiling below assumes lock holders only do filesystem work.

import * as fs from "fs";
import * as path from "path";

/** Past this age a lock is stale regardless of its pid: a live pid may be a
 *  recycled one, and no filesystem-only critical section runs this long. */
export const LOCK_CEILING_MS = 60_000;

interface LockInfo {
  pid: number;
  acquired_at: string;
}

/** Another holder of the same machinery: a lock file of its own under `root`,
 *  and the age past which it is stale whatever its pid. A holder that runs
 *  for hours (an eval check on one batch) passes Infinity and is reclaimed
 *  only when its pid is gone. */
export interface LockOptions {
  name?: string;
  ceilingMs?: number;
}

function lockPathFor(root: string, o: LockOptions = {}): string {
  return path.join(root, o.name ?? ".codecast-capability.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AcquireResult {
  acquired: boolean;
  /** Set when a stale lock was reclaimed on the way in. */
  reclaimedFrom?: LockInfo;
  /** Set when the lock is genuinely held by a live process. */
  heldBy?: LockInfo;
}

export function acquireLock(root: string, log: (line: string) => void = console.error, o: LockOptions = {}): AcquireResult {
  fs.mkdirSync(root, { recursive: true });
  const file = lockPathFor(root, o);
  const ceilingMs = o.ceilingMs ?? LOCK_CEILING_MS;
  const info: LockInfo = { pid: process.pid, acquired_at: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      return { acquired: true };
    } catch {
      // Lock exists. Stale?
      let holder: LockInfo | undefined;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        holder = undefined; // unreadable lock = stale by definition
      }
      const age = holder?.acquired_at ? Date.now() - Date.parse(holder.acquired_at) : Infinity;
      const stale =
        holder === undefined ||
        !pidAlive(holder.pid) ||
        !(age < ceilingMs); // NaN age (mangled timestamp) counts as stale

      if (!stale) return { acquired: false, heldBy: holder };

      log(
        `reclaiming stale lock at ${file} (pid ${holder?.pid ?? "?"}, acquired ${holder?.acquired_at ?? "unknown"})`,
      );
      try {
        fs.unlinkSync(file);
      } catch {
        // Someone else reclaimed it first; the retry loop handles it.
      }
      if (holder !== undefined) {
        return tryReclaimedAcquire(file, info, holder);
      }
    }
  }
  return { acquired: false };
}

function tryReclaimedAcquire(file: string, info: LockInfo, reclaimed: LockInfo): AcquireResult {
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, JSON.stringify(info));
    fs.closeSync(fd);
    return { acquired: true, reclaimedFrom: reclaimed };
  } catch {
    // Lost the reclaim race to another process — that is a correct outcome.
    return { acquired: false };
  }
}

export function releaseLock(root: string, o: LockOptions = {}): void {
  const file = lockPathFor(root, o);
  try {
    const holder: LockInfo = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Only our own lock: releasing someone else's would reopen the race.
    if (holder.pid === process.pid) fs.unlinkSync(file);
  } catch {
    // Already gone, or unreadable — nothing owned to release.
  }
}

/** Run `fn` under the root's lock. The narrow waist every capability write
 *  should go through; taking the lock by hand is for tests. */
export function withLock<T>(
  root: string,
  fn: () => T,
  log?: (line: string) => void,
): { ok: true; value: T; reclaimedFrom?: LockInfo } | { ok: false; heldBy?: LockInfo } {
  const result = acquireLock(root, log);
  if (!result.acquired) return { ok: false, heldBy: result.heldBy };
  try {
    return { ok: true, value: fn(), reclaimedFrom: result.reclaimedFrom };
  } finally {
    releaseLock(root);
  }
}

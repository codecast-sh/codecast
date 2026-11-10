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

/** An unreadable lock younger than this is a holder caught between creating
 *  the file and filling it (a binary from before the lock was linked in whole),
 *  not a corrupt leftover: it counts as held. */
export const UNREADABLE_LOCK_GRACE_MS = 2_000;

/** Put a complete lock file in place, or fail because one is there. The body
 *  is written to a private temp file and hard-linked in, so no contender can
 *  ever read a lock that exists but is still empty. */
function placeLock(file: string, info: LockInfo): boolean {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(info), { flag: "wx" });
    fs.linkSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never created.
    }
  }
}

function readLockText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function parseLock(text: string | undefined): LockInfo | undefined {
  if (text === undefined) return undefined;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === "object" && typeof doc.pid === "number" ? (doc as LockInfo) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the lock at `file` only if it is still the one judged stale. The
 *  lock is moved aside first and its bytes compared, because a plain unlink
 *  would also delete a live lock another contender placed after reclaiming
 *  the stale one. A lock that turns out to be someone else's is put back. */
function removeStaleLock(file: string, staleText: string): boolean {
  const aside = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.reclaim`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false; // already gone: someone else reclaimed it
  }
  if (readLockText(aside) === staleText) {
    try {
      fs.unlinkSync(aside);
    } catch {
      // Nothing to clean up.
    }
    return true;
  }
  try {
    fs.linkSync(aside, file);
  } catch {
    // A third contender took the path in the gap; it holds the lock now.
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Nothing to clean up.
  }
  return false;
}

export function acquireLock(root: string, log: (line: string) => void = console.error, o: LockOptions = {}): AcquireResult {
  fs.mkdirSync(root, { recursive: true });
  const file = lockPathFor(root, o);
  const ceilingMs = o.ceilingMs ?? LOCK_CEILING_MS;
  const info: LockInfo = { pid: process.pid, acquired_at: new Date().toISOString() };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (placeLock(file, info)) return { acquired: true };

    // Lock exists. Stale?
    const text = readLockText(file);
    if (text === undefined) continue; // released between the two calls: retry
    const holder = parseLock(text);
    if (holder === undefined) {
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // gone since the read: retry
      }
      // Young and unreadable: a holder mid-write, not a corrupt leftover.
      if (ageMs < UNREADABLE_LOCK_GRACE_MS) return { acquired: false };
    }
    const age = holder?.acquired_at ? Date.now() - Date.parse(holder.acquired_at) : Infinity;
    const stale =
      holder === undefined || // unreadable and old = stale by definition
      !pidAlive(holder.pid) ||
      !(age < ceilingMs); // NaN age (mangled timestamp) counts as stale

    if (!stale) return { acquired: false, heldBy: holder };

    log(
      `reclaiming stale lock at ${file} (pid ${holder?.pid ?? "?"}, acquired ${holder?.acquired_at ?? "unknown"})`,
    );
    // Lost the reclaim race to another process: that is a correct outcome.
    if (!removeStaleLock(file, text)) return { acquired: false };
    if (holder !== undefined) {
      return placeLock(file, info) ? { acquired: true, reclaimedFrom: holder } : { acquired: false };
    }
  }
  return { acquired: false };
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

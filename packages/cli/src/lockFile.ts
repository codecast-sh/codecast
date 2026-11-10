/**
 * One cross-process lock for the whole CLI: a pid-stamped file created with
 * O_EXCL, stolen when its holder is dead or has held it past the staleness
 * bound.
 *
 * This is the machine that ended the browser restart stampede (see
 * browser/instance.ts `acquireStartLock`), lifted out of it so the computer
 * helper's launch and bundle swap get the same guarantees instead of a second
 * implementation of the same three hazards:
 *
 *  - the holder exits through `process.exit`, which does NOT run `finally`, so
 *    the release rides an `exit` listener;
 *  - agents wrap these commands in `timeout`, and Node's default disposition
 *    for SIGTERM/SIGINT/SIGHUP terminates without running `exit` listeners, so
 *    each signal gets a handler that releases and re-raises;
 *  - SIGKILL cannot be caught at all, which is what the staleness reclaim is
 *    for: a dead holder pid, or a holder older than `staleMs`, loses the lock.
 *
 * Reclaiming is the one step that removes a file somebody else created, so it
 * is serialised (breakStaleLock): two waiters that both judged the same lock
 * abandoned must not each remove "it", because the second removal lands on the
 * lock the first waiter has just taken.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isPidAlive } from "./workspace/chrome.js";

// How long a lock file may stay unreadable before it counts as a corpse rather
// than a holder that has not finished writing its stamp. Generous next to the
// three syscalls it covers, and far under any staleMs, so a genuinely corrupt
// lock still clears on the next poll.
const HOLDER_STAMP_GRACE_MS = 2_000;

function lockFileAgeMs(lockFile: string): number {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // gone: not a holder to wait for
  }
}

/**
 * Who holds an existing lock file: its live holder's pid, "stale" when the
 * holder is dead or held it past `staleMs` (SIGKILL leaves no release), or
 * "young" for an unreadable file too new to be abandoned.
 *
 * Why "young": create/write/close is three syscalls, so the winner of the
 * O_EXCL race publishes an EMPTY file for a moment. Reading that as "no pid,
 * therefore stale" makes the loser delete a live holder's lock and take one of
 * its own — two processes then both believe they hold it, which a 4-process
 * 15-round stress reproduced 4 times. An unreadable file OLDER than the grace
 * is still a corpse.
 */
function lockHolder(lockFile: string, staleMs: number): Holder {
  let holder: { pid?: number; at?: number } | null = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
  } catch {
    /* unreadable — a corpse, or a holder still mid-write */
  }
  if (!holder && lockFileAgeMs(lockFile) < HOLDER_STAMP_GRACE_MS) return "young";
  holder ??= {};
  const stale = !holder.pid || !isPidAlive(holder.pid) || !holder.at || Date.now() - holder.at > staleMs;
  return stale ? "stale" : holder.pid!;
}

type Holder = number | "stale" | "young";

// A reclaim is a re-read and an unlink. A claim on it older than this was left
// by a waiter killed between the two (or its pid has since been reused).
const BREAK_CLAIM_STALE_MS = 10_000;

/** What a lock or claim file holds, with enough identity (inode and mtime
 *  beside the bytes) to tell it from a successor at the same path. */
function fileIdentity(file: string): { id: string; text: string; ageMs: number } | null {
  try {
    const text = fs.readFileSync(file, "utf-8");
    const st = fs.statSync(file);
    return { id: `${st.ino}:${st.mtimeMs}:${text}`, text, ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

const newStamp = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid: process.pid, at: Date.now(), ...extra, token: randomBytes(8).toString("hex") });

/** Remove `file` only while it still carries `stamp`: a holder that lost its
 *  lock to the staleness bound must not delete the lock of whoever took it. */
function removeIfOurs(file: string, stamp: string): void {
  try {
    if (fs.readFileSync(file, "utf-8") === stamp) fs.unlinkSync(file);
  } catch {
    /* already released */
  }
}

/**
 * Take the right to reclaim `lockFile`: an O_EXCL file beside it. Returns the
 * stamp to release it with, or null when another waiter is reclaiming now.
 *
 * A claim whose owner died mid-reclaim is itself cleared by rename-to-claim:
 * rename is atomic, so of several waiters that judged the same claim dead only
 * one moves it, and that one checks it moved the file it judged before
 * deleting it. A live claim moved by mistake (its owner replaced the dead one
 * between our judgement and our rename) is linked back.
 */
function takeBreakClaim(claim: string): string | null {
  const stamp = newStamp();
  const create = (): boolean => {
    try {
      const fd = fs.openSync(claim, "wx", 0o600);
      try {
        fs.writeSync(fd, stamp);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return stamp;
  const seen = fileIdentity(claim);
  if (!seen) return create() ? stamp : null; // released since our attempt
  let owner: { pid?: number } = {};
  try {
    owner = JSON.parse(seen.text);
  } catch {
    /* mid-write, or a corpse: its age decides */
  }
  const ownerAlive = typeof owner.pid === "number" ? isPidAlive(owner.pid) : seen.ageMs < HOLDER_STAMP_GRACE_MS;
  if (ownerAlive && seen.ageMs < BREAK_CLAIM_STALE_MS) return null;
  const grave = `${claim}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(claim, grave);
  } catch {
    return null; // another waiter cleared it first
  }
  if (fileIdentity(grave)?.id !== seen.id) {
    try {
      fs.linkSync(grave, claim);
    } catch {
      /* a newer claim is already there */
    }
    fs.rmSync(grave, { force: true });
    return null;
  }
  fs.rmSync(grave, { force: true });
  return create() ? stamp : null;
}

/**
 * Remove `lockFile` if its holder is gone. True when the caller should try to
 * create the lock again at once; false when the lock turned out to be held, or
 * another waiter is reclaiming it, and the caller should wait its turn.
 *
 * The judgement a waiter made before calling this proves nothing by the time
 * it acts: another waiter may have reclaimed the same corpse and created its
 * own lock at this path in between, and an unlink here would delete that live
 * lock and leave two holders. So the judgement is made again under the claim,
 * which only one waiter holds at a time. Nothing but a claim holder removes a
 * lock it does not own.
 *
 * One change can still slip in under the claim: a holder that is alive but
 * past `staleMs` releases its own lock, and a newcomer creates one, between
 * the judgement and the removal. So the removal is a rename followed by a
 * check that the file moved is the file judged; a newcomer's lock moved by
 * mistake is linked back.
 */
function breakStaleLock(lockFile: string, staleMs: number): boolean {
  const claim = `${lockFile}.break`;
  const stamp = takeBreakClaim(claim);
  if (!stamp) return false;
  const grave = `${claim}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    const judged = fileIdentity(lockFile);
    if (!judged) return !fs.existsSync(lockFile); // released meanwhile: free to take
    if (lockHolder(lockFile, staleMs) !== "stale") return false;
    try {
      fs.renameSync(lockFile, grave);
    } catch {
      return !fs.existsSync(lockFile); // its holder released it first
    }
    if (fileIdentity(grave)?.id === judged.id) return true;
    try {
      fs.linkSync(grave, lockFile);
    } catch {
      /* a newer lock is already there */
    }
    return false;
  } finally {
    fs.rmSync(grave, { force: true });
    removeIfOurs(claim, stamp);
  }
}

function waitTimeoutMessage(holder: Holder, lockFile: string, waitMs: number, describe?: string): string {
  const secs = Math.round(waitMs / 1000);
  const what = describe ? `another \`${describe}\`` : "another process";
  if (typeof holder === "number") return `${what} (pid ${holder}) has held ${lockFile} for over ${secs}s — if it is stuck, remove ${lockFile}`;
  if (holder === "young") return `${what} was still taking ${lockFile} (its holder stamp is not written yet) after ${secs}s — if it is stuck, remove ${lockFile}`;
  return `${lockFile} was left by a holder that is gone and could not be reclaimed within ${secs}s (another process is reclaiming it, or its directory is not writable) — if it is stuck, remove ${lockFile} and ${lockFile}.break`;
}

/**
 * Run `fn` holding `lockFile`, synchronously: for read-modify-write of a small
 * state file that several CLI processes update at once, where the critical
 * section is a few syscalls and the callers are synchronous. Same reclaim
 * rules as acquireFileLock; the release is in `finally`, and a holder killed
 * mid-section loses the lock to the staleness bound.
 */
export function withFileLockSync<T>(lockFile: string, fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
  const waitMs = opts.waitMs ?? 10_000;
  const staleMs = opts.staleMs ?? 10_000;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let stamp: string;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      stamp = newStamp();
      fs.writeSync(fd, stamp);
      fs.closeSync(fd);
      break;
    } catch {
      const holder = lockHolder(lockFile, staleMs);
      if (holder === "stale" && breakStaleLock(lockFile, staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(waitTimeoutMessage(holder, lockFile, waitMs));
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    removeIfOurs(lockFile, stamp);
  }
}

export interface FileLockOptions {
  /** How long to queue behind another holder before giving up. */
  waitMs?: number;
  /** A holder older than this is presumed dead (SIGKILL leaves no release). */
  staleMs?: number;
  /** Called once when this process starts queueing, so a blocked command can
   *  say so — silence reads as hung, and an agent's answer to hung is to kill
   *  and retry, the exact reflex a lock exists to prevent. */
  onWait?: (holderPid: number) => void;
  /** Names the lock in the timeout error, e.g. "cast browser start". */
  describe?: string;
  /** What the holder is doing, stamped beside its pid so a listing can say. */
  what?: string;
}

/** Take `lockFile` exclusively. Resolves to the release function. */
export async function acquireFileLock(lockFile: string, opts: FileLockOptions = {}): Promise<() => void> {
  const waitMs = opts.waitMs ?? 75_000;
  const staleMs = opts.staleMs ?? 90_000;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      const stamp = newStamp(opts.what ? { what: opts.what } : {});
      fs.writeSync(fd, stamp);
      fs.closeSync(fd);
      const release = () => removeIfOurs(lockFile, stamp);
      process.once("exit", release);
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const onSignal = (sig: NodeJS.Signals) => {
        release();
        cleanup();
        process.kill(process.pid, sig);
      };
      const handlers = signals.map((sig) => {
        const h = () => onSignal(sig);
        process.once(sig, h);
        return [sig, h] as const;
      });
      // bun-types narrows removeListener past Node's signal overloads; the
      // EventEmitter surface is what both runtimes actually implement.
      const emitter = process as NodeJS.EventEmitter;
      const cleanup = () => {
        emitter.removeListener("exit", release);
        for (const [sig, h] of handlers) emitter.removeListener(sig, h);
      };
      return () => {
        cleanup();
        release();
      };
    } catch {
      const holder = lockHolder(lockFile, staleMs);
      // A holder mid-write: wait for its stamp instead of stealing (lockHolder).
      if (holder === "young") {
        await sleep(20);
        continue;
      }
      if (holder === "stale") {
        if (breakStaleLock(lockFile, staleMs)) continue;
        // Another waiter is reclaiming it, or it is held after all: look again
        // shortly, and give up at the deadline like any other wait.
        if (Date.now() >= deadline) throw new Error(waitTimeoutMessage(holder, lockFile, waitMs, opts.describe));
        await sleep(20);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(waitTimeoutMessage(holder, lockFile, waitMs, opts.describe));
      if (!announced) {
        announced = true;
        opts.onWait?.(holder);
      }
      await sleep(300);
    }
  }
}

export type SlotEntry = { pid: number; at: number; what?: string };

const liveEntries = (files: string[], read: (f: string) => unknown): SlotEntry[] =>
  files.flatMap((f) => {
    try {
      const e = read(f) as Partial<SlotEntry>;
      return typeof e.pid === "number" && isPidAlive(e.pid) ? [{ pid: e.pid, at: Number(e.at) || 0, ...(e.what ? { what: String(e.what) } : {}) }] : [];
    } catch {
      return [];
    }
  });

/** Who holds the slots in `dir`, and who waits for one, oldest first. */
export function listFileSlots(dir: string): { holding: SlotEntry[]; waiting: SlotEntry[] } {
  const json = (f: string) => JSON.parse(fs.readFileSync(f, "utf-8"));
  const files = (d: string, match: RegExp) => {
    try { return fs.readdirSync(d).filter((f) => match.test(f)).map((f) => path.join(d, f)); } catch { return []; }
  };
  const byAge = (a: SlotEntry, b: SlotEntry) => a.at - b.at;
  return {
    holding: liveEntries(files(dir, /^slot-\d+\.lock$/), json).sort(byAge),
    waiting: liveEntries(files(path.join(dir, "waiting"), /\.json$/), json).sort(byAge),
  };
}

/**
 * Take one of `slots` interchangeable locks in `dir`, queueing until one frees:
 * a machine-wide cap on how many of something run at once. A slot is held for
 * as long as its holder lives (no staleness bound, since the work it guards
 * may run for an hour); a holder that died frees it on the next try. A caller
 * that has to wait says so in `dir/waiting`, so a listing shows the queue.
 */
export async function acquireFileSlot(
  dir: string,
  slots: number,
  opts: { waitMs?: number; onWait?: () => void; describe?: string; what?: string } = {},
): Promise<() => void> {
  const deadline = Date.now() + (opts.waitMs ?? Number.POSITIVE_INFINITY);
  const ticket = path.join(dir, "waiting", `${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  const leave = () => fs.rmSync(ticket, { force: true });
  try {
    for (;;) {
      for (let i = 0; i < slots; i++) {
        try {
          return await acquireFileLock(path.join(dir, `slot-${i}.lock`), { waitMs: 0, staleMs: Number.POSITIVE_INFINITY, describe: opts.describe, what: opts.what });
        } catch {
          /* held by a live process */
        }
      }
      if (Date.now() > deadline) throw new Error(`all ${slots} ${opts.describe ?? "slots"} are taken; try again later`);
      if (!fs.existsSync(ticket)) {
        fs.mkdirSync(path.dirname(ticket), { recursive: true, mode: 0o700 });
        fs.writeFileSync(ticket, JSON.stringify({ pid: process.pid, at: Date.now(), ...(opts.what ? { what: opts.what } : {}) }), { mode: 0o600 });
        process.once("exit", leave);
        opts.onWait?.();
      }
      await sleep(1_000);
    }
  } finally {
    leave();
    (process as NodeJS.EventEmitter).removeListener("exit", leave);
  }
}

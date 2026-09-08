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
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isPidAlive } from "./pidAlive.js";

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
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      const release = () => {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* already released */
        }
      };
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
      let holder: { pid?: number; at?: number } | null = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
      } catch {
        /* unreadable — a corpse, or a holder still mid-write (below) */
      }
      // Why: create/write/close is three syscalls, so the winner of the O_EXCL
      // race publishes an EMPTY file for a moment. Reading that as "no pid,
      // therefore stale" makes the loser delete a live holder's lock and take
      // one of its own — two processes then both believe they hold it, which a
      // 4-process 15-round stress reproduced 4 times. A file too young to have
      // been abandoned is a holder mid-write; wait for its stamp instead of
      // stealing. An unreadable file OLDER than the grace is still a corpse.
      if (!holder && lockFileAgeMs(lockFile) < HOLDER_STAMP_GRACE_MS) {
        await sleep(20);
        continue;
      }
      holder ??= {};
      const stale = !holder.pid || !isPidAlive(holder.pid) || !holder.at || Date.now() - holder.at > staleMs;
      if (stale) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* someone else removed it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        const what = opts.describe ? `another \`${opts.describe}\`` : "another process";
        throw new Error(
          `${what} (pid ${holder.pid}) has held ${lockFile} for over ${Math.round(waitMs / 1000)}s — ` +
            `if it is stuck, remove ${lockFile}`,
        );
      }
      if (!announced && holder.pid) {
        announced = true;
        opts.onWait?.(holder.pid);
      }
      await sleep(300);
    }
  }
}

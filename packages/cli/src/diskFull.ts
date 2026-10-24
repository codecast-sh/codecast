/**
 * A machine whose disk is full takes no line runs until it has room again.
 *
 * Union's two line hosts filled to 100% with run worktrees on 2026-10-24, and
 * every run placed on them then failed at Start in 14 seconds ("git worktree
 * add -b ...: error: unable to write file ..."): 100 runs in one hour, each
 * counted as its problem failing, while the live flow kept admitting more. A
 * failure the disk caused is the machine's, not the problem's. The run that
 * hit it latches a hold here; the heartbeat then offers the machine's line
 * checkouts with no runs (lineSlots.ts), so admission places nothing there,
 * and the problem goes back to the line's queue. The hold lifts once the disk
 * has resumeBytes free again (the host sweep, hostDiskSweep.ts, is what
 * usually frees it). A disk below floorBytes holds without a failure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { codecastPath } from "./codecastDir.js";

const GiB = 1024 ** 3;
// Room for a run: a checkout with its installs is about 1.5 GB (Union's hosts held ~1.4 GB a worktree).
export const floorBytes = (size: number) => Math.min(size * 0.05, 15 * GiB);
export const resumeBytes = (size: number) => Math.min(size * 0.1, 30 * GiB);

export type DiskSpace = { free: number; size: number };

const ENOSPC_RE = /\bENOSPC\b|no space left on device|disk quota exceeded|\bEDQUOT\b/i;
// git reports a full disk this way, with no errno text: "error: unable to write file ...".
const WRITE_FAILED_RE = /unable to write|could not write|failed to write|write error|short write/i;

/** The free and whole bytes of the disk holding `dir`, or null when they cannot be read. */
export function diskSpace(dir: string): DiskSpace | null {
  try {
    const s = fs.statfsSync(dir);
    return s.blocks > 0 ? { free: s.bavail * s.bsize, size: s.blocks * s.bsize } : null;
  } catch {
    return null;
  }
}

/** Free space on the disk holding `dir`, as a share of its size (0 to 1), or null when it cannot be read. */
export function freeDiskShare(dir: string): number | null {
  const d = diskSpace(dir);
  return d ? d.free / d.size : null;
}

/** Whether `error` is the disk filling: its words, and a disk that is in fact (nearly) full. */
export function isDiskFullError(error: string, space: DiskSpace | null): boolean {
  if (!space) return false;
  if (ENOSPC_RE.test(error)) return space.free < resumeBytes(space.size);
  return WRITE_FAILED_RE.test(error) && space.free < floorBytes(space.size);
}

type Latch = { at: number; dir: string; error: string };
const latchFile = () => codecastPath("disk-full.json");

function readLatch(): Latch | null {
  try {
    const l = JSON.parse(fs.readFileSync(latchFile(), "utf-8"));
    return typeof l?.dir === "string" ? l : null;
  } catch {
    return null;
  }
}

const fullWords = (d: DiskSpace | null) => d ? `${Math.round((1 - d.free / d.size) * 100)}% full, ${(d.free / GiB).toFixed(1)} GB free` : "full";

/**
 * Why line runs may not start on the disk holding `dir` now, or null when they
 * may. A latch whose disk has room again is cleared here.
 */
export function diskFullHold(dir: string, space = diskSpace(dir)): string | null {
  if (space && space.free < floorBytes(space.size)) return `disk ${fullWords(space)}`;
  const latch = readLatch();
  if (!latch) return null;
  let sameDisk = false;
  try { sameDisk = fs.statSync(latch.dir).dev === fs.statSync(dir).dev; } catch { sameDisk = path.resolve(latch.dir) === path.resolve(dir); }
  if (!sameDisk) return null;
  if (space && space.free >= resumeBytes(space.size)) {
    try { fs.unlinkSync(latchFile()); } catch {}
    return null;
  }
  return `disk ${fullWords(space)} (a run failed on it: ${latch.error.split("\n")[0].slice(0, 160)})`;
}

/**
 * When `error`, met by a run working in `dir`, is the disk filling: latch the
 * hold and return the run's fail reason, which names the machine and says the
 * problem goes back to the queue. Null for any other error.
 */
export function diskFullFailReason(dir: string, error: string, task?: string, now = Date.now()): string | null {
  const space = diskSpace(dir);
  if (!isDiskFullError(error, space)) return null;
  try {
    fs.mkdirSync(path.dirname(latchFile()), { recursive: true });
    fs.writeFileSync(latchFile(), JSON.stringify({ at: now, dir, error: error.slice(0, 1000) } satisfies Latch));
  } catch {}
  return `${os.hostname()} ran out of disk (${fullWords(space)}): this is the machine's failure, not the problem's. The machine takes no line runs until its disk has room again${task ? `, and ${task} goes back to the line's queue` : ""}. ${error}`;
}

/** Put a problem whose run the machine failed back in the line's queue (`cast line requeue`): whether it went, and what the server said. */
export async function requeueAfterDiskFull(post: (route: string, body: Record<string, unknown>) => Promise<any>, task: string): Promise<{ queued: boolean; text: string }> {
  try {
    const r = await post("/cli/line/requeue", { task });
    return r?.queued ? { queued: true, text: r.queued } : { queued: false, text: `could not put ${task} back in the queue${r?.error ? `: ${r.error}` : ""}` };
  } catch (err) {
    return { queued: false, text: `could not put ${task} back in the queue: ${err instanceof Error ? err.message : String(err)}` };
  }
}

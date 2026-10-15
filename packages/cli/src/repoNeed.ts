/**
 * What a repo says a machine needs for a session to do its real work there
 * (`.codecast/workspace.toml` `[host] memory_gb`: its typecheck, dev server
 * and a browser beside a few agents), and the words for a machine that falls
 * short. Placement reads it to size and choose cloud hosts; `cast check` and
 * `cast dev` read it to say up front, on whatever machine they run, that the
 * work will not fit, and to name a kernel OOM kill as one when it happens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseManifest } from "./workspace/manifest.js";

const GiB = 1024 ** 3;
const gb = (n: number) => (n / GiB).toFixed(1);

export interface RepoNeed {
  memoryBytes: number;
}

/** The repo's declared need; undefined when it declares none or the manifest does not parse. */
export function readRepoNeed(repoRoot: string | undefined): RepoNeed | undefined {
  if (!repoRoot) return undefined;
  try {
    const gbs = parseManifest(path.join(repoRoot, ".codecast", "workspace.toml"))?.host?.memory_gb;
    return gbs ? { memoryBytes: gbs * GiB } : undefined;
  } catch {
    return undefined;
  }
}

/** Why a machine of this size is too small for the need, or undefined. */
export function tooSmallFor(room: { memoryTotal?: number }, need: RepoNeed | undefined): string | undefined {
  if (!need || room.memoryTotal === undefined) return undefined;
  // A "16 GB" instance reports a little under 16 GiB to the kernel.
  if (room.memoryTotal >= need.memoryBytes * 0.9) return undefined;
  return `it has ${gb(room.memoryTotal)} GB of memory and this repo needs ${gb(need.memoryBytes)} GB to typecheck and run its dev server ([host] memory_gb in .codecast/workspace.toml)`;
}

/** The note for a tool about to start on this machine when it is smaller than the repo needs. */
export function thisMachineTooSmall(repoRoot: string, totalBytes = os.totalmem()): string | undefined {
  const why = tooSmallFor({ memoryTotal: totalBytes }, readRepoNeed(repoRoot));
  return why ? `this machine is too small for this repo: ${why}. Expect the whole program to run out of memory here; a worker on a bigger machine (cast spawn --subagent) can run it` : undefined;
}

/** The kernel's count of out-of-memory kills since boot (/proc/vmstat oom_kill); undefined off Linux. */
export function oomKillCount(vmstat?: string): number | undefined {
  let text = vmstat;
  if (text === undefined) {
    try { text = fs.readFileSync("/proc/vmstat", "utf-8"); } catch { return undefined; }
  }
  const n = Number(text.match(/^oom_kill (\d+)$/m)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One line naming a death by memory, or undefined when it was something else.
 * The process must have died of SIGKILL. On Linux the kernel's OOM counter
 * must also have moved while it ran; elsewhere the SIGKILL alone is read as
 * memory, and said as likely.
 */
export function memoryDeath(opts: {
  what: string;
  /** It died of SIGKILL (a shell wrapper reports that as exit 137). */
  killed: boolean;
  oomBefore: number | undefined;
  oomAfter: number | undefined;
  repoRoot?: string;
  totalBytes?: number;
  freeBytes?: number;
}): string | undefined {
  // The OOM killer always sends SIGKILL; its counter is machine-wide, so it only confirms one.
  if (!opts.killed) return undefined;
  const counted = opts.oomBefore !== undefined && opts.oomAfter !== undefined;
  if (counted && opts.oomAfter! <= opts.oomBefore!) return undefined;
  const total = opts.totalBytes ?? os.totalmem();
  const free = opts.freeBytes ?? os.freemem();
  const small = opts.repoRoot ? tooSmallFor({ memoryTotal: total }, readRepoNeed(opts.repoRoot)) : undefined;
  return `${opts.what} was killed ${counted ? "by the kernel's out-of-memory killer" : "(SIGKILL), most likely for memory"}: this machine has ${gb(total)} GB of memory, ${gb(free)} GB free now${small ? `, and this repo needs more (${small})` : ""}. Free memory here (stop other sessions or servers), or run it on a bigger machine (a worker there: cast spawn --subagent)`;
}

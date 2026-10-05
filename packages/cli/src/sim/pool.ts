/**
 * The simulator pool: which simulators agents share on this machine, and who
 * holds each one.
 *
 * A lock is a directory `<lockDir>/<udid>.lock` holding `pid` (the owner),
 * `since` (epoch seconds) and, when known, `session` (the agent session). The
 * format is the one the old /usr/local/bin/sim-* scripts wrote, so a lock taken
 * by either side is honoured by the other. The owner is the longest-lived
 * process behind the caller (the agent, not the shell that ran the command),
 * so a lock lives as long as the session and turns STALE when it exits; a stale
 * lock is free to take.
 *
 * The pool itself is `$SIM_POOL` (colon-separated `UDID` or `UDID=Name`), else
 * `~/.codecast/sim/pool.json`, else empty; `ensurePool` (sim/simctl.ts) creates
 * codecast-owned devices the first time a machine with none acquires one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { sessionIdFromEnv } from "../sessionIdentity.js";

export interface PoolDevice {
  udid: string;
  name: string;
}

export type LockState = "free" | "held" | "stale";

export interface PoolEntry extends PoolDevice {
  index: number;
  state: LockState;
  pid?: number;
  /** The owner's program name (claude, codex, bash…), when it is alive. */
  owner?: string;
  session?: string;
  since?: number;
}

export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIM_LOCK_DIR || "/tmp/sim-locks";
}

export function poolFile(home: string = process.env.HOME || os.homedir()): string {
  return path.join(home, ".codecast", "sim", "pool.json");
}

export function parsePoolEnv(value: string): PoolDevice[] {
  return value.split(":").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const eq = entry.indexOf("=");
    return eq < 0 ? { udid: entry, name: entry } : { udid: entry.slice(0, eq), name: entry.slice(eq + 1) };
  });
}

export function readPool(env: NodeJS.ProcessEnv = process.env): PoolDevice[] {
  if (env.SIM_POOL) return parsePoolEnv(env.SIM_POOL);
  try {
    const raw = JSON.parse(fs.readFileSync(poolFile(env.HOME || os.homedir()), "utf-8"));
    const devices = Array.isArray(raw?.devices) ? raw.devices : [];
    return devices.filter((d: any) => typeof d?.udid === "string").map((d: any) => ({ udid: d.udid, name: typeof d.name === "string" ? d.name : d.udid }));
  } catch {
    return [];
  }
}

export function writePool(devices: PoolDevice[], home: string = process.env.HOME || os.homedir()): void {
  const file = poolFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ devices }, null, 2)}\n`);
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function psField(pid: number, field: "ppid" | "comm"): string {
  const r = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf-8" });
  return (r.stdout ?? "").trim();
}

/** Programs that run other programs: never the owner of a lock. */
const WRAPPERS = new Set(["bash", "sh", "zsh", "fish", "dash", "login", "script", "timeout", "env", "nice", "caffeinate", "xargs", "sudo"]);

export interface ProcInfo {
  ppid: number;
  comm: string;
}

/**
 * The process that should own a lock: walk up from `start` past shells and
 * wrappers to the first real program (claude, codex, node, bun…). A chain that
 * ends at tmux or launchd is a human shell, and then the outermost shell owns
 * it, so the lock dies with the pane.
 */
export function ownerPid(start: number, info: (pid: number) => ProcInfo | null = defaultProcInfo): number {
  let pid = start;
  let lastShell: number | undefined;
  for (let hops = 0; pid > 1 && hops < 64; hops++) {
    const p = info(pid);
    if (!p) break;
    const comm = path.basename(p.comm).replace(/^-/, "");
    if (WRAPPERS.has(comm)) {
      lastShell = pid;
      pid = p.ppid;
      continue;
    }
    if (!comm || comm.startsWith("tmux") || comm === "launchd") break;
    return pid;
  }
  return lastShell ?? start;
}

function defaultProcInfo(pid: number): ProcInfo | null {
  const comm = psField(pid, "comm");
  if (!comm) return null;
  return { comm, ppid: parseInt(psField(pid, "ppid"), 10) || 0 };
}

/** This command's owner: SIM_OWNER_PID when set, else the walk from our parent. */
export function callerOwnerPid(env: NodeJS.ProcessEnv = process.env): number {
  const named = parseInt(env.SIM_OWNER_PID ?? "", 10);
  return Number.isFinite(named) && named > 0 ? named : ownerPid(process.ppid);
}

const lockPath = (udid: string, dir: string) => path.join(dir, `${udid}.lock`);

function readNum(file: string): number | undefined {
  try {
    const n = parseInt(fs.readFileSync(file, "utf-8").replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function readLock(udid: string, dir = lockDir()): Omit<PoolEntry, "index" | "name" | "udid"> {
  const p = lockPath(udid, dir);
  if (!fs.existsSync(p)) return { state: "free" };
  const pid = readNum(path.join(p, "pid"));
  let session: string | undefined;
  try { session = fs.readFileSync(path.join(p, "session"), "utf-8").trim() || undefined; } catch {}
  const alive = pidAlive(pid);
  return {
    state: alive ? "held" : "stale",
    pid,
    session,
    since: readNum(path.join(p, "since")),
    owner: alive && pid ? path.basename(psField(pid, "comm")) || undefined : undefined,
  };
}

export function poolStatus(pool = readPool(), dir = lockDir()): PoolEntry[] {
  return pool.map((d, index) => ({ ...d, index, ...readLock(d.udid, dir) }));
}

export function releaseLock(udid: string, dir = lockDir()): boolean {
  const p = lockPath(udid, dir);
  if (!fs.existsSync(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}

export interface AcquireResult {
  device: PoolDevice;
  index: number;
  /** A stale lock this acquire took over: whose it was. */
  reclaimed?: number;
}

/** Take one pool simulator for `owner`; `preferred` is tried first. Null when every one is held. */
export function acquire(opts: { pool?: PoolDevice[]; preferred?: number; owner?: number; session?: string | null; dir?: string } = {}): AcquireResult | null {
  const pool = opts.pool ?? readPool();
  const dir = opts.dir ?? lockDir();
  const owner = opts.owner ?? callerOwnerPid();
  const session = opts.session === undefined ? sessionIdFromEnv() : opts.session;
  fs.mkdirSync(dir, { recursive: true });
  const order = pool.map((_, i) => i);
  if (opts.preferred !== undefined && opts.preferred >= 0 && opts.preferred < pool.length) {
    order.splice(order.indexOf(opts.preferred), 1);
    order.unshift(opts.preferred);
  }
  for (const i of order) {
    const device = pool[i];
    const lock = readLock(device.udid, dir);
    let reclaimed: number | undefined;
    if (lock.state === "stale") {
      reclaimed = lock.pid;
      releaseLock(device.udid, dir);
    }
    try {
      fs.mkdirSync(lockPath(device.udid, dir));
    } catch {
      continue;
    }
    const p = lockPath(device.udid, dir);
    fs.writeFileSync(path.join(p, "pid"), `${owner}\n`);
    fs.writeFileSync(path.join(p, "since"), `${Math.floor(Date.now() / 1000)}\n`);
    if (session) fs.writeFileSync(path.join(p, "session"), `${session}\n`);
    return { device, index: i, ...(reclaimed ? { reclaimed } : {}) };
  }
  return null;
}

/**
 * The simulator this caller holds: a held lock whose owner is our owner, or
 * whose session is ours. The default target of every per-device command.
 */
export function heldByCaller(status = poolStatus(), owner = callerOwnerPid(), session = sessionIdFromEnv()): PoolEntry | undefined {
  return status.find((e) => e.state === "held" && (e.pid === owner || (!!session && e.session === session)));
}

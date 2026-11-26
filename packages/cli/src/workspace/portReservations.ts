import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile } from "../atomicWrite.js";
import { spawnSync } from "../proc.js";
import { listStates, type PersistedWorkspaceState } from "./contract.js";
import { defaultConfigDir } from "../config/configDir.js";

export interface PortReservation {
  repoRoot: string;
  workspace: PersistedWorkspaceState;
}

export function partitionReservations(reservations: PortReservation[]): {
  live: PortReservation[];
  stale: Array<{ reservation: PortReservation; reason: string }>;
} {
  const live: PortReservation[] = [];
  const stale: Array<{ reservation: PortReservation; reason: string }> = [];
  const branches = new Map<string, Set<string> | null>();
  for (const reservation of reservations) {
    const { repoRoot, workspace } = reservation;
    if (workspace.state === "creating" || workspace.state === "destroying" ||
      fs.existsSync(workspaceOperationFile(repoRoot, workspace.name)) ||
      (fs.existsSync(workspace.path) && fs.realpathSync(workspace.path) === fs.realpathSync(repoRoot))) {
      live.push(reservation);
      continue;
    }
    let reason: string | undefined;
    if (!fs.existsSync(workspace.path)) reason = "worktree missing";
    else {
      if (!branches.has(repoRoot)) {
        const result = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
          cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        branches.set(repoRoot, result.status === 0 ? new Set(result.stdout.trim().split("\n")) : null);
      }
      if (workspace.branch && branches.get(repoRoot) && !branches.get(repoRoot)!.has(workspace.branch)) reason = "branch gone";
    }
    if (reason) stale.push({ reservation, reason });
    else live.push(reservation);
  }
  return { live, stale };
}

function workspaceOperationFile(root: string, name: string): string {
  const key = createHash("sha256").update(JSON.stringify([root, name])).digest("hex");
  return path.join(defaultConfigDir(), "workspace-ports", "operations", `${key}.json`);
}

interface ReservationLockOwner {
  pid: number;
  /** The owner's process group, which whatever it starts joins: how a successor finds what outlived it. A lock without
   *  one (written by an older cast, or when ps did not answer) is never reclaimed. */
  pgid?: number;
  /** When the owner started, as `ps lstart` says: with the pid, an identity a reused pid cannot fake. */
  started?: string;
  token: string;
  acquired_at: string;
}

/** A process's group and start time as `ps` reports them; empty when ps does not answer. */
function psIdentity(pid: number): { pgid?: number; started?: string } {
  // lstart is printed in the caller's locale and timezone: fixed, so every process that compares it reads one form.
  const r = spawnSync("ps", ["-o", "pgid=,lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(String(r.stdout ?? ""));
  const pgid = Number(m?.[1]);
  return m && Number.isSafeInteger(pgid) && pgid > 0 ? { pgid, started: m[2].replace(/\s+/g, " ") } : {};
}

let ownIdentity: { pgid?: number; started?: string } | undefined;

/** Whether the lock owner's pid is dead. */
function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Whether a live pid now names another process than the one that started at `started` (the owner died and the pid
 *  was handed out again). A `ps` that answers nothing proves nothing: only a different start time counts. */
function pidReused(pid: number, started: string): boolean {
  const now = psIdentity(pid).started;
  return !!now && now !== started;
}

/**
 * Whether anything a dead lock owner started may still be running. Its children keep its process group when it dies,
 * though their parent link goes elsewhere. An owner that led its group (a station, the daemon, a command from a shell)
 * left something behind exactly when that group still has a member. One that ran inside another's group shares it
 * with the living, so any orphan in it counts as its: on macOS an orphan is a member launchd (pid 1) adopted, other
 * than the leader. Elsewhere a subreaper may adopt it instead (Linux's prctl PR_SET_CHILD_SUBREAPER, systemd user
 * managers), so an orphan cannot be told from a sibling and the answer is unknown. Unknown counts as left behind.
 */
function ownerLeftProcesses(holder: { pid: number; pgid: number }): boolean {
  const group = holder.pgid;
  if (group === holder.pid) {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  if (process.platform !== "darwin") return true;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  if (ps.status !== 0) return true;
  return String(ps.stdout).split("\n").some((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return pgid === group && ppid === 1 && pid !== group;
  });
}

/** Remove a dead owner's lock, once: under a takeover claim (one waiter at a time), and only while the lock still holds
 *  what was judged dead, so a lock another waiter took meanwhile is never removed. A claim its maker abandoned is
 *  cleared once old. */
function reclaimReservationLock(file: string, judged: string): void {
  const claim = `${file}.takeover`;
  try {
    fs.mkdirSync(claim);
  } catch {
    try { if (Date.now() - fs.statSync(claim).mtimeMs > 30_000) fs.rmSync(claim, { recursive: true, force: true }); } catch {}
    return;
  }
  try {
    let now: string | undefined;
    try { now = fs.readFileSync(file, "utf8"); } catch {}
    if (now === judged) fs.unlinkSync(file);
  } finally {
    fs.rmSync(claim, { recursive: true, force: true });
  }
}

function parseReservationLock(text: string): Partial<ReservationLockOwner> & { pid: number } | undefined {
  try {
    const owner = JSON.parse(text);
    const validToken = typeof owner?.token === "string" && owner.token.length > 0;
    const legacy = owner?.token === undefined && typeof owner?.acquired_at === "string" && Number.isFinite(Date.parse(owner.acquired_at));
    const validGroup = owner?.pgid === undefined || (Number.isSafeInteger(owner.pgid) && owner.pgid > 0);
    const validStart = owner?.started === undefined || (typeof owner.started === "string" && owner.started.length > 0);
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && validGroup && validStart && (validToken || legacy)) return owner;
  } catch {
    return undefined;
  }
}

function readReservationLock(file: string): Partial<ReservationLockOwner> & { pid: number } | undefined {
  try {
    return parseReservationLock(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function tryReservationLock(file: string, owner: ReservationLockOwner): boolean {
  const temp = `${file}.${owner.token}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function withWorkspaceOperation<T>(repoRoot: string, name: string, fn: () => Promise<T>): Promise<T> {
  const root = fs.realpathSync(repoRoot);
  const file = workspaceOperationFile(root, name);
  const directory = path.dirname(file);
  const token = randomUUID();
  await withPortReservations(root, async () => {
    if (fs.existsSync(file)) {
      const holder = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(holder.pid) || holder.pid <= 0) throw new Error(`workspace '${name}' has an invalid operation owner`);
      let alive = true;
      try { process.kill(holder.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error(`workspace '${name}' has an operation in progress (pid ${holder.pid})`);
      throw new Error(`workspace '${name}' has an interrupted operation; inspect remaining child processes before removing ${file}`);
    }
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteFile(file, JSON.stringify({ pid: process.pid, token }));
  });
  try {
    return await fn();
  } finally {
    await withPortReservations(root, async () => {
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file);
    });
  }
}

export async function withPortReservations<T>(
  repoRoot: string,
  fn: (reservations: PortReservation[]) => Promise<T>,
): Promise<T> {
  const root = fs.realpathSync(repoRoot);
  const directory = path.join(defaultConfigDir(), "workspace-ports");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".codecast-capability.lock");
  ownIdentity ??= psIdentity(process.pid);
  const owner = { pid: process.pid, ...ownIdentity, token: randomUUID(), acquired_at: new Date().toISOString() };
  const deadline = Date.now() + 30_000;
  // The lock whose owner's start time was last compared: ps runs once per owner, not on every poll.
  let compared: string | undefined;
  while (!tryReservationLock(lock, owner)) {
    let judged: string | undefined;
    try { judged = fs.readFileSync(lock, "utf8"); } catch {}
    const holder = judged === undefined ? undefined : parseReservationLock(judged);
    if (holder) {
      let gone = pidDead(holder.pid);
      if (!gone && holder.started && judged !== compared) {
        compared = judged;
        gone = pidReused(holder.pid, holder.started);
      }
      if (gone) {
        // A crash leaves its lock behind; it holds every worktree on the machine until removed, so it is removed
        // here when the owner named its group and nothing it started may still be writing what the lock guards.
        if (holder.pgid === undefined || ownerLeftProcesses({ pid: holder.pid, pgid: holder.pgid })) {
          throw new Error(`Workspace port reservations have an interrupted owner (pid ${holder.pid}); inspect remaining child processes before manually removing ${lock}`);
        }
        reclaimReservationLock(lock, judged!);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace port reservations (${holder ? `pid ${holder.pid}` : "unreadable owner"}); inspect ${lock} before manual recovery`);
    }
    await sleep(25);
  }

  try {
    const file = path.join(directory, "repositories.json");
    const known: string[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const reservations = [...new Set([...known, root])].flatMap((repo) =>
      listStates(repo)
        .filter((workspace) => !workspace.manifest.backend || workspace.manifest.backend === "local")
        .map((workspace) => ({ repoRoot: repo, workspace })),
    );
    const roots = [...new Set([...reservations.map((reservation) => reservation.repoRoot), root])];
    atomicWriteFile(file, JSON.stringify(roots));
    const result = await fn(reservations);
    atomicWriteFile(file, JSON.stringify(roots.filter((repo) => listStates(repo).length > 0)));
    return result;
  } finally {
    if (readReservationLock(lock)?.token === owner.token) fs.unlinkSync(lock);
  }
}

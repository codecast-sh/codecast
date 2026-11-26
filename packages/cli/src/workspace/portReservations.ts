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
  /** The owner's process group, which whatever it starts joins: how a successor finds what outlived it. */
  pgid?: number;
  token: string;
  acquired_at: string;
}

let ownGroup: number | null | undefined;
/** This process's group as `ps` reports it, read once; undefined when ps does not answer. */
function processGroup(): number | undefined {
  if (ownGroup === undefined) {
    const r = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    const pgid = Number(String(r.stdout ?? "").trim());
    ownGroup = Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
  }
  return ownGroup ?? undefined;
}

/**
 * Whether anything a dead lock owner started may still be running. Its children keep its process group when it dies,
 * though their parent link goes to init. An owner that led its group (a station, the daemon, a command from a shell)
 * left something behind exactly when that group still has a member. One that ran inside another's group shares it
 * with the living, so any orphan in it (a member init adopted, other than the leader) counts as its. Unknown counts
 * as left behind.
 */
function ownerLeftProcesses(holder: { pid: number; pgid?: number }): boolean {
  const group = holder.pgid ?? holder.pid;
  if (group === holder.pid) {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
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
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && validGroup && (validToken || legacy)) return owner;
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
  const pgid = processGroup();
  const owner = { pid: process.pid, ...(pgid ? { pgid } : {}), token: randomUUID(), acquired_at: new Date().toISOString() };
  const deadline = Date.now() + 30_000;
  while (!tryReservationLock(lock, owner)) {
    let judged: string | undefined;
    try { judged = fs.readFileSync(lock, "utf8"); } catch {}
    const holder = judged === undefined ? undefined : parseReservationLock(judged);
    if (holder) {
      try {
        process.kill(holder.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          // A crash leaves its lock behind; it holds every worktree on the machine until removed, so it is removed
          // here unless something the owner started may still be writing what the lock guards.
          if (ownerLeftProcesses(holder)) {
            throw new Error(`Workspace port reservations have an interrupted owner (pid ${holder.pid}); inspect remaining child processes before manually removing ${lock}`);
          }
          reclaimReservationLock(lock, judged!);
        }
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
